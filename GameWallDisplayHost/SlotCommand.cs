namespace GameWallDisplayHost;

/// <summary>
/// A single command sent from the remote (phone/browser) to the Display Host
/// over the local WebSocket connection. All fields are nullable/optional
/// since only a subset applies to any given "action".
/// </summary>
public sealed class SlotCommand
{
    // "navigate" | "mute" | "volume" | "close" | "clear" | "layout" | "test" | "closeAll" | "displays" | "monitor" | "hello" | "wallState" | "restoreSnapshot" | "syncSlot" | "endSession" | "identify"
    public string Action { get; set; } = "";

    // Which slot (0-7) this command targets. Not used for "layout"/"test"/"closeAll".
    public int? Slot { get; set; }

    // For "navigate": the URL to load into the slot.
    public string? Url { get; set; }

    // Optional metadata for display & state tracking
    public string? Label { get; set; }
    public string? Network { get; set; }
    public string? GameId { get; set; }
    public string? LastGameJson { get; set; }

    // For "mute": true = mute, false = unmute.
    public bool? Muted { get; set; }

    // For "volume": 0.0 - 1.0.
    public double? Volume { get; set; }

    // For "layout": one of "1","2","4","6","8","featured","custom".
    public string? Layout { get; set; }

    // Zero-based Windows monitor index for the "monitor" command.
    public int? Monitor { get; set; }

    // Friendly label sent by a remote on connect.
    public string? Name { get; set; }

    // Set by the cloud relay: the paired phone that sent this command.
    public string? From { get; set; }

    // Optional custom fractional rectangles for layout = "custom"
    public CustomSlotRect[]? Rects { get; set; }

    // Optional snapshot payload for "restoreSnapshot"
    public WallState? Snapshot { get; set; }
}

public sealed class CustomSlotRect
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Width { get; set; }
    public double Height { get; set; }
}

public sealed class SlotState
{
    public int Index { get; set; }
    public string? Url { get; set; }
    public string? Label { get; set; }
    public string? Network { get; set; }
    public bool Muted { get; set; }
    public double Volume { get; set; } = 1.0;
    public string Health { get; set; } = "ok";
    public string? GameId { get; set; }
    public string? LastUrl { get; set; }
    public string? LastLabel { get; set; }
    public string? LastNetwork { get; set; }
    public string? LastGameJson { get; set; }
}

public sealed class WallState
{
    public string Type { get; set; } = "wallState";
    public long Revision { get; set; }
    public string Layout { get; set; } = "4";
    public CustomSlotRect[]? CustomRects { get; set; }
    public int ActiveMonitor { get; set; }
    public SlotState[] Slots { get; set; } = Array.Empty<SlotState>();
    public string[] Clients { get; set; } = Array.Empty<string>();
    // True while the wall is showing (a game session is running).
    public bool SessionActive { get; set; }
    public string? DeviceName { get; set; }
}

/// <summary>
/// Optional status message sent back to the remote so it can reflect
/// current state (which slot has which URL, mute state, etc).
/// </summary>
public sealed class SlotStatus
{
    public int Slot { get; set; }
    public string? Url { get; set; }
    public bool Muted { get; set; }
    public bool Visible { get; set; }
}

public sealed class DisplayStatus
{
    public string Type { get; set; } = "displays";
    public int SelectedIndex { get; set; }
    public required DisplayInfo[] Displays { get; init; }
}

public sealed class DisplayInfo
{
    public required int Index { get; init; }
    public required string Name { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
}

public sealed class SlotHealth
{
    public string Type { get; set; } = "slotHealth";
    public int Slot { get; set; }
    public string Status { get; set; } = "ok";
}
