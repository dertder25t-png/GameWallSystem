namespace GameWallDisplayHost;

/// <summary>
/// A single command sent from the remote (phone/browser) to the Display Host
/// over the local WebSocket connection. All fields are nullable/optional
/// since only a subset applies to any given "action".
/// </summary>
public sealed class SlotCommand
{
    // "navigate" | "mute" | "volume" | "close" | "layout" | "test" | "closeAll" | "displays" | "monitor"
    public string Action { get; set; } = "";

    // Which slot (0-7) this command targets. Not used for "layout"/"test"/"closeAll".
    public int? Slot { get; set; }

    // For "navigate": the URL to load into the slot.
    public string? Url { get; set; }

    // For "mute": true = mute, false = unmute.
    public bool? Muted { get; set; }

    // For "volume": 0.0 - 1.0.
    public double? Volume { get; set; }

    // For "layout": one of "1","2","4","6","8","featured".
    public string? Layout { get; set; }

    // Zero-based Windows monitor index for the "monitor" command.
    public int? Monitor { get; set; }
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
