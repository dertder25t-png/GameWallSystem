using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

/// <summary>The cloud link must notice a connection that went silent and dial again.</summary>
public class CloudBridgeConnectionTests
{
    /// <summary>
    /// A WebSocket server that accepts connections and then never says anything, like a
    /// half-open connection after the laptop wakes from sleep.
    /// </summary>
    private sealed class SilentServer : IDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly List<TcpClient> _clients = new();
        private int _connections;

        public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
        public int Connections => Volatile.Read(ref _connections);

        public SilentServer()
        {
            _listener.Start();
            _ = AcceptLoopAsync();
        }

        private async Task AcceptLoopAsync()
        {
            try
            {
                while (true)
                {
                    var client = await _listener.AcceptTcpClientAsync();
                    lock (_clients) _clients.Add(client);
                    _ = HandshakeAndIgnoreAsync(client);
                }
            }
            catch { }
        }

        private async Task HandshakeAndIgnoreAsync(TcpClient client)
        {
            try
            {
                var stream = client.GetStream();
                var request = new StringBuilder();
                var one = new byte[1];
                while (!request.ToString().EndsWith("\r\n\r\n") && await stream.ReadAsync(one) == 1)
                    request.Append((char)one[0]);
                var key = request.ToString().Split("\r\n")
                    .First(l => l.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                    .Split(':', 2)[1].Trim();
                var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                await stream.WriteAsync(Encoding.ASCII.GetBytes(
                    $"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"));
                Interlocked.Increment(ref _connections);

                var ws = WebSocket.CreateFromStream(stream, isServer: true, subProtocol: null, keepAliveInterval: Timeout.InfiniteTimeSpan);
                var buffer = new byte[4096];
                while (ws.State == WebSocketState.Open)
                    await ws.ReceiveAsync(buffer, CancellationToken.None); // read joins/heartbeats, never answer
            }
            catch (Exception ex) when (ex is IOException or WebSocketException or ObjectDisposedException) { }
        }

        public void Dispose()
        {
            _listener.Stop();
            lock (_clients) foreach (var c in _clients) c.Dispose();
        }
    }

    private static AgentSettings RegisteredSettings() => new()
    {
        DeviceId = "test-device",
        DeviceSecretProtected = AgentStore.Protect("secret"),
        SignKeyProtected = AgentStore.Protect(Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))),
        CommandTopic = "cmd-test",
        StateTopic = "state-test",
    };

    [Fact]
    public async Task SilentConnection_IsDroppedAndRedialed()
    {
        using var server = new SilentServer();
        var bridge = new CloudBridge(RegisteredSettings(), wsUrl: () => $"ws://127.0.0.1:{server.Port}/")
        {
            HeartbeatInterval = TimeSpan.FromMilliseconds(200),
            SilenceLimit = TimeSpan.FromMilliseconds(800),
        };
        bridge.Start();
        try
        {
            // First dial right away; after ~1 s of silence it gives up and dials again
            // (after its 2 s reconnect delay).
            var deadline = DateTime.UtcNow.AddSeconds(15);
            while (server.Connections < 2 && DateTime.UtcNow < deadline)
                await Task.Delay(100);

            Assert.True(server.Connections >= 2, $"expected a redial, saw {server.Connections} connection(s)");
        }
        finally
        {
            bridge.Dispose();
        }
    }
}
