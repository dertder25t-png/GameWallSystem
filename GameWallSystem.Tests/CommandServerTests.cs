using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

public class CommandServerTests
{
    private static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private static async Task<ClientWebSocket> ConnectAsync(int port)
    {
        var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/"), CancellationToken.None);
        return ws;
    }

    private static async Task<string?> ReceiveTextAsync(ClientWebSocket ws, TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await ws.ReceiveAsync(buffer, cts.Token);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            message.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(message.ToArray());
    }

    /// <summary>Reads messages until one of the given type arrives (skips "clients" updates).</summary>
    private static async Task<JsonElement> ReceiveOfTypeAsync(ClientWebSocket ws, string type)
    {
        while (true)
        {
            var text = await ReceiveTextAsync(ws, TimeSpan.FromSeconds(10)) ?? throw new Exception("closed");
            var root = JsonDocument.Parse(text).RootElement;
            if (root.TryGetProperty("type", out var t) && t.GetString() == type) return root;
        }
    }

    [Fact]
    public async Task Command_FromRemote_IsRaised()
    {
        var port = FreePort();
        var server = new CommandServer(port);
        var received = new TaskCompletionSource<SlotCommand>();
        server.CommandReceived += c => received.TrySetResult(c);
        server.Start();
        try
        {
            using var ws = await ConnectAsync(port);
            var json = Encoding.UTF8.GetBytes("{\"action\":\"navigate\",\"slot\":2,\"url\":\"https://example.com\"}");
            await ws.SendAsync(json, WebSocketMessageType.Text, true, CancellationToken.None);

            var cmd = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("navigate", cmd.Action);
            Assert.Equal(2, cmd.Slot);
        }
        finally { server.Stop(); }
    }

    [Fact]
    public async Task ManyBroadcastsAtOnce_AllArriveIntact()
    {
        var port = FreePort();
        var server = new CommandServer(port);
        server.Start();
        try
        {
            using var ws = await ConnectAsync(port);
            await ReceiveOfTypeAsync(ws, "clients");

            const int count = 50;
            var payload = new string('x', 20_000);
            var sends = Task.WhenAll(Enumerable.Range(0, count)
                .Select(i => server.BroadcastAsync(new { Type = "test", N = i, Payload = payload })));

            var seen = new HashSet<int>();
            while (seen.Count < count)
            {
                var msg = await ReceiveOfTypeAsync(ws, "test");
                Assert.Equal(payload, msg.GetProperty("payload").GetString());
                seen.Add(msg.GetProperty("n").GetInt32());
            }
            await sends;
        }
        finally { server.Stop(); }
    }

    [Fact]
    public async Task ClientThatStopsReading_IsDropped_AndDoesNotBlockOthers()
    {
        var port = FreePort();
        var server = new CommandServer(port);
        server.Start();
        try
        {
            // A raw TCP client that finishes the handshake and then never reads again.
            using var stuck = new TcpClient();
            stuck.ReceiveBufferSize = 1024;
            await stuck.ConnectAsync(IPAddress.Loopback, port);
            var stuckStream = stuck.GetStream();
            var handshake = "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
            await stuckStream.WriteAsync(Encoding.ASCII.GetBytes(handshake));

            using var good = await ConnectAsync(port);
            await ReceiveOfTypeAsync(good, "clients");

            // Enough data to fill the stuck client's socket buffers many times over.
            var payload = new string('y', 256 * 1024);
            var sends = Task.WhenAll(Enumerable.Range(0, 40)
                .Select(i => server.BroadcastAsync(new { Type = "big", N = i, Payload = payload })));

            // The good client keeps getting messages while the stuck one is backed up...
            var first = await ReceiveOfTypeAsync(good, "big");
            Assert.Equal(payload.Length, first.GetProperty("payload").GetString()!.Length);

            // ...and every broadcast finishes (the stuck client is dropped after the send timeout)
            // instead of waiting on it forever.
            var finished = await Task.WhenAny(sends, Task.Delay(TimeSpan.FromSeconds(30)));
            Assert.Same(sends, finished);
        }
        finally { server.Stop(); }
    }

    [Fact]
    public async Task EndlessHeaderLine_IsRejected()
    {
        var port = FreePort();
        var server = new CommandServer(port);
        server.Start();
        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, port);
            var stream = client.GetStream();
            await stream.WriteAsync(Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nX-Junk: "));

            var junk = Encoding.ASCII.GetBytes(new string('a', 4096));
            var closed = false;
            try
            {
                for (var i = 0; i < 64 && !closed; i++)
                {
                    await stream.WriteAsync(junk);
                    await Task.Delay(5);
                }
                // The server stops reading after 8 KB and drops the connection.
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                closed = await stream.ReadAsync(new byte[1], cts.Token) == 0;
            }
            catch (IOException)
            {
                closed = true;
            }
            Assert.True(closed);
        }
        finally { server.Stop(); }
    }

    [Fact]
    public async Task OversizedMessage_ClosesThatConnection()
    {
        var port = FreePort();
        var server = new CommandServer(port);
        server.Start();
        try
        {
            using var ws = await ConnectAsync(port);
            var chunk = new byte[256 * 1024];
            try
            {
                for (var i = 0; i < 8; i++)
                    await ws.SendAsync(chunk, WebSocketMessageType.Text, endOfMessage: false, CancellationToken.None);
            }
            catch (WebSocketException) { }

            string? next = "";
            try
            {
                while (next is not null) next = await ReceiveTextAsync(ws, TimeSpan.FromSeconds(5));
            }
            catch (WebSocketException) { next = null; }
            Assert.Null(next);
        }
        finally { server.Stop(); }
    }
}
