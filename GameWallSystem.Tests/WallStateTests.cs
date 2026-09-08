using System.Text.Json;
using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

public class WallStateTests
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    [Fact]
    public void WallState_InitializesWithDefaults()
    {
        var state = new WallState();

        Assert.Equal("wallState", state.Type);
        Assert.Equal(0, state.Revision);
        Assert.Equal("4", state.Layout);
        Assert.NotNull(state.Slots);
        Assert.Empty(state.Slots);
        Assert.NotNull(state.Clients);
        Assert.Empty(state.Clients);

        // Populate 8 slots as Display Host does
        state.Slots = Enumerable.Range(0, 8).Select(i => new SlotState { Index = i }).ToArray();
        Assert.Equal(8, state.Slots.Length);

        for (int i = 0; i < 8; i++)
        {
            Assert.Equal(i, state.Slots[i].Index);
            Assert.Null(state.Slots[i].Url);
            Assert.Null(state.Slots[i].Label);
            Assert.False(state.Slots[i].Muted);
            Assert.Equal(1.0, state.Slots[i].Volume);
            Assert.Equal("ok", state.Slots[i].Health);
        }
    }

    [Fact]
    public void WallState_SerializesAndDeserializesCorrectly()
    {
        var state = new WallState
        {
            Revision = 42,
            Layout = "featured",
            Clients = new[] { "Living Room iPad", "Pixel 8" },
            Slots = new SlotState[]
            {
                new()
                {
                    Index = 0,
                    Url = "https://www.espn.com/watch/player/_/id/123",
                    Label = "Georgia @ Alabama",
                    Network = "ABC",
                    Muted = false,
                    Volume = 0.85,
                    GameId = "401628500",
                    LastUrl = "https://www.espn.com/watch/player/_/id/123",
                    LastLabel = "Georgia @ Alabama",
                    LastNetwork = "ABC",
                    LastGameJson = "{\"homeTeam\":\"Alabama\",\"awayTeam\":\"Georgia\"}"
                }
            }
        };

        var json = JsonSerializer.Serialize(state, JsonOptions);
        var restored = JsonSerializer.Deserialize<WallState>(json, JsonOptions);

        Assert.NotNull(restored);
        Assert.Equal(42, restored.Revision);
        Assert.Equal("featured", restored.Layout);
        Assert.Equal(2, restored.Clients.Length);
        Assert.Contains("Living Room iPad", restored.Clients);

        var slot0 = restored.Slots[0];
        Assert.Equal("Georgia @ Alabama", slot0.Label);
        Assert.Equal("ABC", slot0.Network);
        Assert.Equal("401628500", slot0.GameId);
        Assert.Equal(0.85, slot0.Volume);
        Assert.False(slot0.Muted);
        Assert.NotNull(slot0.LastGameJson);
    }

    [Fact]
    public void SlotCommand_ParsesExtendedActionsAndMetadata()
    {
        // 1. Clear action
        var clearJson = "{\"action\":\"clear\",\"slot\":2}";
        var clearCmd = JsonSerializer.Deserialize<SlotCommand>(clearJson, JsonOptions);
        Assert.NotNull(clearCmd);
        Assert.Equal("clear", clearCmd.Action);
        Assert.Equal(2, clearCmd.Slot);

        // 2. Navigate with rich metadata
        var navJson = "{\"action\":\"navigate\",\"slot\":1,\"url\":\"https://stream.test\",\"label\":\"Texas @ Oklahoma\",\"network\":\"ABC\",\"gameId\":\"401628501\",\"lastGameJson\":\"{\\\"id\\\":\\\"401628501\\\"}\"}";
        var navCmd = JsonSerializer.Deserialize<SlotCommand>(navJson, JsonOptions);
        Assert.NotNull(navCmd);
        Assert.Equal("navigate", navCmd.Action);
        Assert.Equal(1, navCmd.Slot);
        Assert.Equal("Texas @ Oklahoma", navCmd.Label);
        Assert.Equal("ABC", navCmd.Network);
        Assert.Equal("401628501", navCmd.GameId);

        // 3. Restore snapshot action
        var snapJson = "{\"action\":\"restoreSnapshot\",\"snapshot\":{\"layout\":\"split3\",\"slots\":[]}}";
        var snapCmd = JsonSerializer.Deserialize<SlotCommand>(snapJson, JsonOptions);
        Assert.NotNull(snapCmd);
        Assert.Equal("restoreSnapshot", snapCmd.Action);
        Assert.NotNull(snapCmd.Snapshot);

        // 4. Volume action
        var volJson = "{\"action\":\"volume\",\"slot\":0,\"volume\":0.4}";
        var volCmd = JsonSerializer.Deserialize<SlotCommand>(volJson, JsonOptions);
        Assert.NotNull(volCmd);
        Assert.Equal("volume", volCmd.Action);
        Assert.Equal(0.4, volCmd.Volume);
    }

    [Fact]
    public void SlotState_PreservesSoftCloseVsHardClearSemantics()
    {
        var slot = new SlotState
        {
            Index = 3,
            Url = "https://stream.test",
            Label = "Ohio State @ Michigan",
            Network = "FOX",
            LastUrl = "https://stream.test",
            LastLabel = "Ohio State @ Michigan",
            LastNetwork = "FOX",
            GameId = "401628505"
        };

        // Soft close: Url and Label become null, but Last* fields are preserved
        slot.Url = null;
        slot.Label = null;
        slot.Network = null;

        Assert.Null(slot.Url);
        Assert.Null(slot.Label);
        Assert.Equal("https://stream.test", slot.LastUrl);
        Assert.Equal("Ohio State @ Michigan", slot.LastLabel);
        Assert.Equal("FOX", slot.LastNetwork);
        Assert.Equal("401628505", slot.GameId);

        // Hard clear: wipes memory completely
        slot.LastUrl = null;
        slot.LastLabel = null;
        slot.LastNetwork = null;
        slot.LastGameJson = null;
        slot.GameId = null;

        Assert.Null(slot.LastUrl);
        Assert.Null(slot.LastLabel);
        Assert.Null(slot.LastNetwork);
        Assert.Null(slot.GameId);
    }
}
