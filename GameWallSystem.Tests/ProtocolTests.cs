using System.Text.Json;
using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

public class ProtocolTests
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    [Fact]
    public void HelloCommand_DeserializesClientName()
    {
        var json = "{\"action\":\"hello\",\"name\":\"Basement iPad Pro\"}";
        var cmd = JsonSerializer.Deserialize<SlotCommand>(json, JsonOptions);

        Assert.NotNull(cmd);
        Assert.Equal("hello", cmd.Action);
        Assert.Equal("Basement iPad Pro", cmd.Name);
    }

    [Fact]
    public void CustomLayoutCommand_DeserializesFractionalRects()
    {
        var json = "{\"action\":\"layout\",\"layout\":\"custom\",\"rects\":[{\"x\":0.1,\"y\":0.1,\"width\":0.4,\"height\":0.4},{\"x\":0.5,\"y\":0.5,\"width\":0.5,\"height\":0.5}]}";
        var cmd = JsonSerializer.Deserialize<SlotCommand>(json, JsonOptions);

        Assert.NotNull(cmd);
        Assert.Equal("layout", cmd.Action);
        Assert.Equal("custom", cmd.Layout);
        Assert.NotNull(cmd.Rects);
        Assert.Equal(2, cmd.Rects.Length);
        Assert.Equal(0.1, cmd.Rects[0].X);
        Assert.Equal(0.4, cmd.Rects[0].Width);
    }

    [Fact]
    public void SyncSlotCommand_DeserializesTargetIndex()
    {
        var json = "{\"action\":\"syncSlot\",\"slot\":5}";
        var cmd = JsonSerializer.Deserialize<SlotCommand>(json, JsonOptions);

        Assert.NotNull(cmd);
        Assert.Equal("syncSlot", cmd.Action);
        Assert.Equal(5, cmd.Slot);
    }
}
