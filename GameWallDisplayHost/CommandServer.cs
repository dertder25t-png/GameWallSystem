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
    private readonly int _port;
    private TcpListener? _listener;
    private readonly List<WebSocket> _clients = new();
    private readonly object _clientsLock = new();

    public event Action<SlotCommand>? CommandReceived;

    public CommandServer(int port)
    {
        _port = port;
    }

    public void Start()
    {
        _listener = new TcpListener(IPAddress.Any, _port);
        _listener.Start();
        _ = AcceptLoopAsync();
    }

    public void Stop()
    {
        _listener?.Stop();
    }

    private async Task AcceptLoopAsync()
    {
        while (true)
        {
            TcpClient client;
            try
            {
                client = await _listener!.AcceptTcpClientAsync();
            }
            catch (ObjectDisposedException)
            {
                return; // listener was stopped
            }

            _ = HandleClientAsync(client);
        }
    }

    private async Task HandleClientAsync(TcpClient client)
    {
        using var _ = client;
        client.NoDelay = true;
        var stream = client.GetStream();

        // --- Read the HTTP upgrade request line-by-line ---
        string? webSocketKey = null;
        var requestLine = await ReadHttpLineAsync(stream);
        if (requestLine is null || !requestLine.StartsWith("GET"))
            return;

        string? line;
        while (!string.IsNullOrEmpty(line = await ReadHttpLineAsync(stream)))
        {
            var idx = line.IndexOf(':');
            if (idx <= 0) continue;
            var name = line[..idx].Trim();
            var value = line[(idx + 1)..].Trim();
            if (string.Equals(name, "Sec-WebSocket-Key", StringComparison.OrdinalIgnoreCase))
                webSocketKey = value;
        }

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
        await stream.WriteAsync(responseBytes);

        // --- Hand the raw stream off to the framework's WebSocket implementation ---
        var socket = WebSocket.CreateFromStream(stream, isServer: true, subProtocol: null,
            keepAliveInterval: TimeSpan.FromSeconds(30));

        lock (_clientsLock) _clients.Add(socket);

        var buffer = new byte[8192];
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close)
                    break;

                var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                try
                {
                    var command = JsonSerializer.Deserialize<SlotCommand>(json,
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                    if (command is not null)
                        CommandReceived?.Invoke(command);
                }
                catch (JsonException)
                {
                    // ignore malformed messages rather than killing the connection
                }
            }
        }
        catch (WebSocketException)
        {
            // client disconnected abruptly - fine, just clean up below
        }
        finally
        {
            lock (_clientsLock) _clients.Remove(socket);
            socket.Dispose();
        }
    }

    /// <summary>Broadcasts a status update to every connected remote.</summary>
    public async Task BroadcastAsync(SlotStatus status)
    {
        var json = JsonSerializer.Serialize(status);
        var bytes = Encoding.UTF8.GetBytes(json);

        List<WebSocket> snapshot;
        lock (_clientsLock) snapshot = new List<WebSocket>(_clients);

        foreach (var socket in snapshot)
        {
            if (socket.State != WebSocketState.Open) continue;
            try
            {
                await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (WebSocketException)
            {
                // that client is gone; it'll be cleaned up by its own receive loop
            }
        }
    }

    private static async Task<string?> ReadHttpLineAsync(NetworkStream stream)
    {
        var bytes = new List<byte>();
        var single = new byte[1];
        while (true)
        {
            int read = await stream.ReadAsync(single);
            if (read == 0) return null; // connection closed
            if (single[0] == '\n')
            {
                if (bytes.Count > 0 && bytes[^1] == '\r') bytes.RemoveAt(bytes.Count - 1);
                return Encoding.ASCII.GetString(bytes.ToArray());
            }
            bytes.Add(single[0]);
        }
    }
}
