using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GameWallDisplayHost;

/// <summary>
/// Minimal WebSocket server built directly on TcpListener rather than
/// HttpListener. HttpListener requires admin rights (or a URL ACL
/// reservation via netsh) to bind non-localhost prefixes on Windows;
/// TcpListener on a plain port does not, which matters here since we
/// want the phone/remote to connect over LAN without any setup step.
/// </summary>
public sealed class CommandServer
{
    // Limits for what one remote can make the wall hold on to.
    internal const int MaxHeaderLineBytes = 8 * 1024;
    internal const int MaxHeaderLines = 100;
    internal const int MaxMessageBytes = 1024 * 1024;
    internal static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(10);
    internal static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(5);

    private readonly int _port;
    private readonly IPAddress _bindAddress;
    private TcpListener? _listener;
    private volatile bool _stopped;
    private sealed class ConnectedClient
    {
        public required WebSocket Socket { get; init; }
        public string Name { get; set; } = "Unnamed remote";
        /// <summary>A WebSocket allows one send at a time; broadcasts start from many places at once.</summary>
        public SemaphoreSlim SendLock { get; } = new(1, 1);
    }

    private readonly List<ConnectedClient> _clients = new();
    private readonly object _clientsLock = new();

    public event Action<SlotCommand>? CommandReceived;
    public event Func<Task>? ClientJoined;

    public string[] GetClientNames()
    {
        lock (_clientsLock)
        {
            return _clients.Select(c => c.Name).ToArray();
        }
    }

    /// <param name="bindAddress">
    /// IPAddress.Loopback (default) = only this PC can connect; IPAddress.Any = anyone on the
    /// Wi-Fi can (the old behaviour, now an opt-in "Allow Wi-Fi remote" tray setting).
    /// </param>
    public CommandServer(int port, IPAddress? bindAddress = null)
    {
        _port = port;
        _bindAddress = bindAddress ?? IPAddress.Loopback;
    }

    public void Start()
    {
        _listener = new TcpListener(_bindAddress, _port);
        _listener.Start();
        _ = AcceptLoopAsync();
    }

    public void Stop()
    {
        _stopped = true;
        _listener?.Stop();
    }

    private async Task AcceptLoopAsync()
    {
        while (!_stopped)
        {
            TcpClient client;
            try
            {
                client = await _listener!.AcceptTcpClientAsync();
            }
            catch (Exception ex) when (ex is ObjectDisposedException or SocketException or InvalidOperationException)
            {
                if (_stopped) return; // listener was stopped
                // A connection that failed while being accepted mustn't end the local remote.
                await Task.Delay(200);
                continue;
            }

            _ = HandleClientAsync(client);
        }
    }

    private async Task HandleClientAsync(TcpClient client)
    {
        using var clientLifetime = client;
        client.NoDelay = true;
        var stream = client.GetStream();

        // --- Read the HTTP upgrade request line-by-line ---
        // Bounded in size and time, so a client that never finishes its request (or sends an
        // endless header) can't hold a socket and memory forever.
        string? webSocketKey = null;
        try
        {
            using var handshakeTimeout = new CancellationTokenSource(HandshakeTimeout);
            var ct = handshakeTimeout.Token;
            var requestLine = await ReadHttpLineAsync(stream, ct);
            if (requestLine is null || !requestLine.StartsWith("GET"))
                return;

            string? line;
            var headerLines = 0;
            while (!string.IsNullOrEmpty(line = await ReadHttpLineAsync(stream, ct)))
            {
                if (++headerLines > MaxHeaderLines) return;
                var idx = line.IndexOf(':');
                if (idx <= 0) continue;
                var name = line[..idx].Trim();
                var value = line[(idx + 1)..].Trim();
                if (string.Equals(name, "Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase))
                    webSocketKey = value;
            }
            if (line is null) return; // connection closed or header line too long

            if (webSocketKey is null)
                return; // not a websocket upgrade request

            // --- Compute Sec-WebSocket-Accept per RFC 6455 and send the handshake response ---
            const string magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
            var acceptSrc = webSocketKey + magic;
            var acceptHash = SHA1.HashData(Encoding.UTF8.GetBytes(acceptSrc));
            var acceptKey = Convert.ToBase64String(acceptHash);

            var response =
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {acceptKey}\r\n\r\n";
            var responseBytes = Encoding.ASCII.GetBytes(response);
            await stream.WriteAsync(responseBytes, ct);
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or ObjectDisposedException or SocketException)
        {
            return; // gave up on, or lost, a client that never finished connecting
        }

        // --- Hand the raw stream off to the framework's WebSocket implementation ---
        var socket = WebSocket.CreateFromStream(stream, isServer: true, subProtocol: null,
            keepAliveInterval: TimeSpan.FromSeconds(30));

        var connectedClient = new ConnectedClient { Socket = socket };
        lock (_clientsLock) _clients.Add(connectedClient);
        _ = BroadcastClientsAsync();
        _ = ClientJoined?.Invoke();

        var buffer = new byte[8192];
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                        break;
                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage && message.Length <= MaxMessageBytes);

                if (result.MessageType == WebSocketMessageType.Close)
                    break;
                if (message.Length > MaxMessageBytes)
                {
                    // No real command is anywhere near this size; don't buffer it forever.
                    await socket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "Message too large", CancellationToken.None);
                    break;
                }

                var json = Encoding.UTF8.GetString(message.ToArray());
                try
                {
                    var command = JsonSerializer.Deserialize<SlotCommand>(json,
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                    if (command?.Action == "hello")
                    {
                        connectedClient.Name = string.IsNullOrWhiteSpace(command.Name)
                            ? "Unnamed remote"
                            : command.Name.Trim();
                        _ = BroadcastClientsAsync();
                        _ = ClientJoined?.Invoke();
                    }
                    else if (command is not null)
                        CommandReceived?.Invoke(command);
                }
                catch (JsonException)
                {
                    // ignore malformed messages rather than killing the connection
                }
            }
        }
        catch (Exception ex) when (ex is WebSocketException or IOException or OperationCanceledException or ObjectDisposedException)
        {
            // client disconnected abruptly (or was dropped for not reading) - clean up below
        }
        finally
        {
            lock (_clientsLock) _clients.Remove(connectedClient);
            socket.Dispose();
            _ = BroadcastClientsAsync();
            _ = ClientJoined?.Invoke();
        }
    }

    /// <summary>Broadcasts a status update to every connected remote.</summary>
    public async Task BroadcastAsync(object status)
    {
        var json = JsonSerializer.Serialize(status, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
        var bytes = Encoding.UTF8.GetBytes(json);

        List<ConnectedClient> snapshot;
        lock (_clientsLock) snapshot = _clients.ToList();

        // In parallel, so one slow remote doesn't hold up everyone else's updates.
        await Task.WhenAll(snapshot.Select(client => SendToClientAsync(client, bytes)));
    }

    private static async Task SendToClientAsync(ConnectedClient client, byte[] bytes)
    {
        var socket = client.Socket;
        if (socket.State != WebSocketState.Open) return;
        using var timeout = new CancellationTokenSource(SendTimeout);
        try
        {
            await client.SendLock.WaitAsync(timeout.Token);
            try
            {
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, timeout.Token);
            }
            finally
            {
                client.SendLock.Release();
            }
        }
        catch (Exception)
        {
            // The client is gone, or hasn't taken a message for 5 s (a phone that went to
            // sleep mid-connection). Drop it instead of letting sends queue up behind it;
            // its receive loop cleans up.
            try { socket.Abort(); } catch { }
        }
    }

    private Task BroadcastClientsAsync()
    {
        string[] names;
        lock (_clientsLock) names = _clients.Select(client => client.Name).ToArray();
        return BroadcastAsync(new { Type = "clients", Names = names });
    }

    /// <summary>Reads one header line; null if the connection closed or the line is too long.</summary>
    internal static async Task<string?> ReadHttpLineAsync(Stream stream, CancellationToken ct)
    {
        var bytes = new List<byte>();
        var single = new byte[1];
        while (true)
        {
            int read = await stream.ReadAsync(single, ct);
            if (read == 0) return null; // connection closed
            if (bytes.Count >= MaxHeaderLineBytes) return null;
            if (single[0] == '\n')
            {
                if (bytes.Count > 0 && bytes[^1] == '\r') bytes.RemoveAt(bytes.Count - 1);
                return Encoding.ASCII.GetString(bytes.ToArray());
            }
            bytes.Add(single[0]);
        }
    }
}
