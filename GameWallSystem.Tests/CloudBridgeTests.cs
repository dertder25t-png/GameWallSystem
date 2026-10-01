using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

/// <summary>
/// The laptop must only obey commands signed by the relay with this laptop's key,
/// sent within the last 2 minutes, and never the same message twice.
/// </summary>
public class CloudBridgeTests
{
    private static readonly string Key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    private static JsonObject Sign(string commandJson, long ts, string nonce, string key)
    {
        var sig = HMACSHA256.HashData(Convert.FromBase64String(key), Encoding.UTF8.GetBytes($"{ts}.{nonce}.{commandJson}"));
        return new JsonObject { ["c"] = commandJson, ["ts"] = ts, ["n"] = nonce, ["s"] = Convert.ToBase64String(sig) };
    }

    private static CloudBridge NewBridge() => new(new AgentSettings());

    [Fact]
    public void ValidSignature_IsAccepted()
    {
        var now = DateTimeOffset.UtcNow;
        var cmd = NewBridge().VerifyAndParse(
            Sign("{\"action\":\"layout\",\"layout\":\"featured\",\"from\":\"Caleb\"}", now.ToUnixTimeMilliseconds(), "n1", Key), Key, now);

        Assert.NotNull(cmd);
        Assert.Equal("layout", cmd.Action);
        Assert.Equal("featured", cmd.Layout);
        Assert.Equal("Caleb", cmd.From);
    }

    [Fact]
    public void WrongKey_IsRejected()
    {
        var now = DateTimeOffset.UtcNow;
        var otherKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        Assert.Null(NewBridge().VerifyAndParse(Sign("{\"action\":\"closeAll\"}", now.ToUnixTimeMilliseconds(), "n2", otherKey), Key, now));
    }

    [Fact]
    public void TamperedCommand_IsRejected()
    {
        var now = DateTimeOffset.UtcNow;
        var signed = Sign("{\"action\":\"mute\",\"slot\":1,\"muted\":false}", now.ToUnixTimeMilliseconds(), "n3", Key);
        signed["c"] = "{\"action\":\"mute\",\"slot\":1,\"muted\":true}";
        Assert.Null(NewBridge().VerifyAndParse(signed, Key, now));
    }

    [Fact]
    public void StaleCommand_IsRejected()
    {
        var now = DateTimeOffset.UtcNow;
        var old = now.AddMinutes(-10).ToUnixTimeMilliseconds();
        Assert.Null(NewBridge().VerifyAndParse(Sign("{\"action\":\"closeAll\"}", old, "n4", Key), Key, now));
    }

    [Fact]
    public void ReplayedCommand_IsRejectedTheSecondTime()
    {
        var bridge = NewBridge();
        var now = DateTimeOffset.UtcNow;
        var signed = Sign("{\"action\":\"test\"}", now.ToUnixTimeMilliseconds(), "n5", Key);
        Assert.NotNull(bridge.VerifyAndParse(signed, Key, now));
        Assert.Null(bridge.VerifyAndParse(signed, Key, now.AddSeconds(5)));
    }

    [Fact]
    public void MissingKey_RejectsEverything()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.Null(NewBridge().VerifyAndParse(Sign("{\"action\":\"test\"}", now.ToUnixTimeMilliseconds(), "n6", Key), null, now));
    }
}
