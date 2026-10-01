using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace GameWallDisplayHost;

/// <summary>Project URL and public key for the GameDay Supabase project (safe to ship: public key).</summary>
public static class CloudConfig
{
    public const string AgentVersion = "alpha-0.1";
    public static string SupabaseUrl { get; set; } = "https://lilemnoqfikkrykkrrpt.supabase.co";
    public static string PublicKey { get; set; } =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxpbGVtbm9xZmlra3J5a2tycnB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3Nzg0NzksImV4cCI6MjEwNjM1NDQ3OX0.cEblqDweXieJ1HHsnr_6Jh6u8pnSV5Z9C7x1rVqWsEQ";
    public static string FunctionUrl => SupabaseUrl.TrimEnd('/') + "/functions/v1/wall";
    public static string RealtimeUrl =>
        SupabaseUrl.TrimEnd('/').Replace("https://", "wss://").Replace("http://", "ws://") +
        "/realtime/v1/websocket?apikey=" + Uri.EscapeDataString(PublicKey) + "&vsn=1.0.0";
}

/// <summary>
/// The laptop's link to the phone. It only ever dials OUT: one WebSocket to Supabase
/// Realtime, joined to two secret topics.
///   command topic: signed commands from the relay function (HMAC-SHA256 with this
///                  laptop's key). Unsigned, stale (&gt;2 min) or replayed messages are dropped.
///   state topic:   wall state this laptop publishes for paired phones, plus a presence
///                  entry so phones can show "online".
/// Commands are handed to the same handler the local WebSocket remote uses, so every
/// existing action (layouts, custom layouts, snapshots, stats panels...) works unchanged.
/// </summary>
public sealed class CloudBridge : IDisposable
{
    public enum LinkState { Offline, Registering, Connecting, Online }

    private static readonly JsonSerializerOptions CamelCase = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly JsonSerializerOptions CaseInsensitive = new() { PropertyNameCaseInsensitive = true };
    private static readonly TimeSpan MaxClockSkew = TimeSpan.FromMinutes(2);

    private readonly HttpClient _http;
    private readonly Func<string> _wsUrl;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _seenNonces = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _cloudClients = new();
    private AgentSettings _settings;
    private ClientWebSocket? _socket;
    private int _ref;
    private string? _stateJoinRef;
    private bool _stateJoined;
    private Task? _runTask;

    public event Action<SlotCommand>? CommandReceived;
    /// <summary>A phone just paired (argument: its name).</summary>
    public event Action<string>? Paired;
    /// <summary>A phone said hello; the host should publish its full state.</summary>
    public event Func<Task>? ClientJoined;
    public event Action<LinkState, string>? StatusChanged;

    public LinkState State { get; private set; } = LinkState.Offline;
    public string StatusMessage { get; private set; } = "Starting";
    public AgentSettings Settings => _settings;

    public CloudBridge(AgentSettings settings, HttpClient? http = null, Func<string>? wsUrl = null)
    {
        _settings = settings;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        _wsUrl = wsUrl ?? (() => CloudConfig.RealtimeUrl);
    }

    public void Start() => _runTask ??= Task.Run(() => RunAsync(_stop.Token));

    public string[] GetClientNames()
    {
        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-15);
        foreach (var stale in _cloudClients.Where(kv => kv.Value < cutoff).Select(kv => kv.Key).ToList())
            _cloudClients.TryRemove(stale, out _);
        return _cloudClients.Keys.Select(name => $"{name} (phone)").ToArray();
    }

    // ------------------------------------------------------------------ relay calls

    private async Task<JsonObject> CallAsync(object body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, CloudConfig.FunctionUrl)
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.TryAddWithoutValidation("apikey", CloudConfig.PublicKey);
        using var response = await _http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        JsonObject? obj = null;
        try { obj = JsonNode.Parse(text) as JsonObject; } catch (JsonException) { }
        if (!response.IsSuccessStatusCode)
        {
            var message = obj?["error"]?.GetValue<string>() ?? $"HTTP {(int)response.StatusCode}";
            throw new CloudCallException((int)response.StatusCode, message);
        }
        return obj ?? new JsonObject();
    }

    private object DeviceAuth(string op, object? extra = null)
    {
        var body = new Dictionary<string, object?>
        {
            ["op"] = op,
            ["deviceId"] = _settings.DeviceId,
            ["deviceSecret"] = AgentStore.Unprotect(_settings.DeviceSecretProtected),
            ["version"] = CloudConfig.AgentVersion,
        };
        if (extra is not null)
            foreach (var kv in JsonSerializer.SerializeToElement(extra).EnumerateObject())
                body[kv.Name] = kv.Value;
        return body;
    }

    private async Task EnsureRegisteredAsync(CancellationToken ct)
    {
        if (_settings.HasIdentity && AgentStore.Unprotect(_settings.DeviceSecretProtected) is not null
            && AgentStore.Unprotect(_settings.SignKeyProtected) is not null)
            return;

        SetStatus(LinkState.Registering, "Registering this laptop");
        var result = await CallAsync(new { op = "register", name = _settings.DeviceName, version = CloudConfig.AgentVersion }, ct);
        _settings.DeviceId = result["deviceId"]!.GetValue<string>();
        _settings.DeviceSecretProtected = AgentStore.Protect(result["deviceSecret"]!.GetValue<string>());
        _settings.SignKeyProtected = AgentStore.Protect(result["signKey"]!.GetValue<string>());
        _settings.CommandTopic = result["commandTopic"]!.GetValue<string>();
        _settings.StateTopic = result["stateTopic"]!.GetValue<string>();
        AgentStore.Save(_settings);
    }

    /// <summary>Gets a fresh 6-digit pairing code (valid 10 minutes).</summary>
    public async Task<(string Code, DateTimeOffset ExpiresAt)> RequestPairingCodeAsync(CancellationToken ct = default)
    {
        await EnsureRegisteredAsync(ct);
        JsonObject result;
        try
        {
            result = await CallAsync(DeviceAuth("code"), ct);
        }
        catch (CloudCallException ex) when (ex.Status is 401 or 404)
        {
            // The server no longer knows this laptop: start over with a new identity.
            ResetIdentity();
            await EnsureRegisteredAsync(ct);
            RestartConnection();
            result = await CallAsync(DeviceAuth("code"), ct);
        }
        return (result["code"]!.GetValue<string>(), DateTimeOffset.Parse(result["expiresAt"]!.GetValue<string>()));
    }

    public async Task<string[]> GetPairedPhonesAsync(CancellationToken ct = default)
    {
        await EnsureRegisteredAsync(ct);
        var result = await CallAsync(DeviceAuth("device_info"), ct);
        return result["phones"]?.AsArray().Select(p => p?["name"]?.GetValue<string>() ?? "Phone").ToArray() ?? Array.Empty<string>();
    }

    public async Task ForgetAllPhonesAsync(CancellationToken ct = default)
    {
        await EnsureRegisteredAsync(ct);
        await CallAsync(DeviceAuth("forget_phones"), ct);
        _cloudClients.Clear();
    }

    private void ResetIdentity()
    {
        _settings.DeviceId = null;
        _settings.DeviceSecretProtected = null;
        _settings.SignKeyProtected = null;
        _settings.CommandTopic = null;
        _settings.StateTopic = null;
        AgentStore.Save(_settings);
    }

    private void RestartConnection()
    {
        try { _socket?.Abort(); } catch { }
    }

    // ------------------------------------------------------------------ realtime link

    private async Task RunAsync(CancellationToken ct)
    {
        var attempt = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await EnsureRegisteredAsync(ct);
                await ConnectAndListenAsync(ct);
                attempt = 0;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                SetStatus(LinkState.Offline, $"Offline: {ex.Message}");
            }

            if (ct.IsCancellationRequested) break;
            attempt++;
            var delay = TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, Math.Min(attempt, 5))));
            SetStatus(LinkState.Offline, $"Reconnecting in {delay.TotalSeconds:0}s");
            try { await Task.Delay(delay, ct); } catch (OperationCanceledException) { break; }
        }
        SetStatus(LinkState.Offline, "Stopped");
    }

    private async Task ConnectAndListenAsync(CancellationToken ct)
    {
        SetStatus(LinkState.Connecting, "Connecting");
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        _socket = socket;
        _stateJoined = false;
        await socket.ConnectAsync(new Uri(_wsUrl()), ct);

        var cmdTopic = "realtime:" + _settings.CommandTopic;
        var stateTopic = "realtime:" + _settings.StateTopic;
        var cmdJoinRef = NextRef();
        _stateJoinRef = NextRef();
        await SendFrameAsync(new { topic = cmdTopic, @event = "phx_join", payload = JoinPayload(null), @ref = cmdJoinRef, join_ref = cmdJoinRef }, ct);
        await SendFrameAsync(new { topic = stateTopic, @event = "phx_join", payload = JoinPayload("agent"), @ref = _stateJoinRef, join_ref = _stateJoinRef }, ct);

        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var heartbeat = HeartbeatLoopAsync(heartbeatCts.Token);
        var cmdJoined = false;
        try
        {
            var buffer = new byte[64 * 1024];
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, ct);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                JsonObject? frame;
                try { frame = JsonNode.Parse(message.ToArray()) as JsonObject; }
                catch (JsonException) { continue; }
                if (frame is null) continue;

                var topic = frame["topic"]?.GetValue<string>();
                var ev = frame["event"]?.GetValue<string>();
                var payload = frame["payload"] as JsonObject;

                if (ev == "phx_reply")
                {
                    var status = payload?["status"]?.GetValue<string>();
                    var replyRef = frame["ref"]?.GetValue<string>();
                    if (replyRef == cmdJoinRef)
                    {
                        if (status != "ok") throw new InvalidOperationException("Command channel join refused");
                        cmdJoined = true;
                    }
                    else if (replyRef == _stateJoinRef)
                    {
                        if (status != "ok") throw new InvalidOperationException("State channel join refused");
                        _stateJoined = true;
                        await TrackPresenceAsync(ct);
                    }
                    if (cmdJoined && _stateJoined && State != LinkState.Online)
                    {
                        SetStatus(LinkState.Online, "Online");
                        if (ClientJoined is not null) _ = ClientJoined.Invoke();
                    }
                }
                else if (ev is "phx_error" or "phx_close")
                {
                    if (topic == cmdTopic || topic == stateTopic)
                        throw new InvalidOperationException($"Channel closed by server ({ev})");
                }
                else if (ev == "broadcast" && topic == cmdTopic && payload is not null)
                {
                    HandleBroadcast(payload);
                }
            }
        }
        finally
        {
            heartbeatCts.Cancel();
            try { await heartbeat; } catch { }
            _stateJoined = false;
            _socket = null;
            if (State == LinkState.Online) SetStatus(LinkState.Offline, "Connection lost");
        }
    }

    private static object JoinPayload(string? presenceKey) => new
    {
        config = new
        {
            broadcast = new { ack = false, self = false },
            presence = new { key = presenceKey ?? "" },
            postgres_changes = Array.Empty<object>(),
            @private = false,
        },
    };

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(25), ct);
            await SendFrameAsync(new { topic = "phoenix", @event = "heartbeat", payload = new { }, @ref = NextRef() }, ct);
        }
    }

    private Task TrackPresenceAsync(CancellationToken ct) => SendFrameAsync(new
    {
        topic = "realtime:" + _settings.StateTopic,
        @event = "presence",
        payload = new
        {
            type = "presence",
            @event = "track",
            payload = new { role = "agent", name = _settings.DeviceName, version = CloudConfig.AgentVersion, since = DateTimeOffset.UtcNow },
        },
        @ref = NextRef(),
        join_ref = _stateJoinRef,
    }, ct);

    /// <summary>Publishes a state message (wallState, displays, slotHealth, clients...) to paired phones.</summary>
    public async Task PublishAsync(object message)
    {
        if (!_stateJoined || _socket is null || _socket.State != WebSocketState.Open) return;
        var body = JsonSerializer.SerializeToNode(message, CamelCase);
        try
        {
            await SendFrameAsync(new
            {
                topic = "realtime:" + _settings.StateTopic,
                @event = "broadcast",
                payload = new { type = "broadcast", @event = "state", payload = body },
                @ref = NextRef(),
                join_ref = _stateJoinRef,
            }, _stop.Token);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // The run loop notices the dead socket and reconnects.
        }
    }

    private async Task SendFrameAsync(object frame, CancellationToken ct)
    {
        var socket = _socket;
        if (socket is null || socket.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
        await _sendLock.WaitAsync(ct);
        try { await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct); }
        finally { _sendLock.Release(); }
    }

    private string NextRef() => Interlocked.Increment(ref _ref).ToString();

    // ------------------------------------------------------------------ signed commands

    private void HandleBroadcast(JsonObject payload)
    {
        if (payload["event"]?.GetValue<string>() != "cmd") return;
        if (payload["payload"] is not JsonObject signed) return;
        var command = VerifyAndParse(signed, AgentStore.Unprotect(_settings.SignKeyProtected), DateTimeOffset.UtcNow);
        if (command is null) return;

        var from = (command.From ?? command.Name ?? "Phone").Trim();
        if (from.Length == 0) from = "Phone";
        _cloudClients[from] = DateTimeOffset.UtcNow;
        switch (command.Action)
        {
            case "paired":
                Paired?.Invoke(command.Name ?? from);
                if (ClientJoined is not null) _ = ClientJoined.Invoke();
                break;
            case "hello":
                if (ClientJoined is not null) _ = ClientJoined.Invoke();
                CommandReceived?.Invoke(new SlotCommand { Action = "displays" });
                break;
            default:
                CommandReceived?.Invoke(command);
                break;
        }
    }

    /// <summary>
    /// Checks the relay's HMAC over "ts.nonce.command", rejects stale or replayed
    /// messages, and parses the command. Returns null for anything that fails.
    /// </summary>
    public SlotCommand? VerifyAndParse(JsonObject signed, string? signKeyB64, DateTimeOffset now)
    {
        try
        {
            if (signKeyB64 is null) return null;
            var c = signed["c"]?.GetValue<string>();
            var n = signed["n"]?.GetValue<string>();
            var s = signed["s"]?.GetValue<string>();
            var tsNode = signed["ts"];
            if (c is null || n is null || s is null || tsNode is null) return null;
            var ts = tsNode.GetValue<long>();

            var expected = HMACSHA256.HashData(Convert.FromBase64String(signKeyB64), Encoding.UTF8.GetBytes($"{ts}.{n}.{c}"));
            byte[] given;
            try { given = Convert.FromBase64String(s); } catch (FormatException) { return null; }
            if (!CryptographicOperations.FixedTimeEquals(expected, given)) return null;

            var sent = DateTimeOffset.FromUnixTimeMilliseconds(ts);
            if ((now - sent).Duration() > MaxClockSkew) return null;

            foreach (var old in _seenNonces.Where(kv => now - kv.Value > MaxClockSkew + MaxClockSkew).Select(kv => kv.Key).ToList())
                _seenNonces.TryRemove(old, out _);
            if (!_seenNonces.TryAdd(n, now)) return null;

            return JsonSerializer.Deserialize<SlotCommand>(c, CaseInsensitive);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    private void SetStatus(LinkState state, string message)
    {
        State = state;
        StatusMessage = message;
        StatusChanged?.Invoke(state, message);
    }

    public void Dispose()
    {
        _stop.Cancel();
        RestartConnection();
    }
}

public sealed class CloudCallException : Exception
{
    public int Status { get; }
    public CloudCallException(int status, string message) : base(message) => Status = status;
}
