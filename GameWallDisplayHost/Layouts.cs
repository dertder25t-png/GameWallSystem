namespace GameWallDisplayHost;

/// <summary>
/// Describes where one slot sits in the grid.
/// </summary>
public readonly record struct SlotPlacement(int Row, int Col, int RowSpan, int ColSpan);

public readonly record struct FractionalRect(double X, double Y, double Width, double Height);

/// <summary>
/// Describes a full layout: how many rows/cols the grid needs,
/// and where each of the (up to 8) slots goes. Slots beyond
/// VisibleCount are hidden.
/// </summary>
public sealed class LayoutDefinition
{
    public required int Rows { get; init; }
    public required int Cols { get; init; }
    public required int VisibleCount { get; init; }
    public required SlotPlacement[] Placements { get; init; }
    public required FractionalRect[] FractionalPlacements { get; init; }
}

public static class Layouts
{
    // 1-up: one slot fills everything.
    public static readonly LayoutDefinition OneUp = new()
    {
        Rows = 1,
        Cols = 1,
        VisibleCount = 1,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 1.0, 1.0),
        }
    };

    // 2-up: side by side.
    public static readonly LayoutDefinition TwoUp = new()
    {
        Rows = 1,
        Cols = 2,
        VisibleCount = 2,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 1, 1),
            new SlotPlacement(0, 1, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 0.5, 1.0),
            new FractionalRect(0.5, 0.0, 0.5, 1.0),
        }
    };

    // 4-up: classic 2x2.
    public static readonly LayoutDefinition FourUp = new()
    {
        Rows = 2,
        Cols = 2,
        VisibleCount = 4,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 1, 1),
            new SlotPlacement(0, 1, 1, 1),
            new SlotPlacement(1, 0, 1, 1),
            new SlotPlacement(1, 1, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 0.5, 0.5),
            new FractionalRect(0.5, 0.0, 0.5, 0.5),
            new FractionalRect(0.0, 0.5, 0.5, 0.5),
            new FractionalRect(0.5, 0.5, 0.5, 0.5),
        }
    };

    // 6-up: 2 rows x 3 cols.
    public static readonly LayoutDefinition SixUp = new()
    {
        Rows = 2,
        Cols = 3,
        VisibleCount = 6,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 1, 1),
            new SlotPlacement(0, 1, 1, 1),
            new SlotPlacement(0, 2, 1, 1),
            new SlotPlacement(1, 0, 1, 1),
            new SlotPlacement(1, 1, 1, 1),
            new SlotPlacement(1, 2, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 1.0 / 3.0, 0.5),
            new FractionalRect(1.0 / 3.0, 0.0, 1.0 / 3.0, 0.5),
            new FractionalRect(2.0 / 3.0, 0.0, 1.0 / 3.0, 0.5),
            new FractionalRect(0.0, 0.5, 1.0 / 3.0, 0.5),
            new FractionalRect(1.0 / 3.0, 0.5, 1.0 / 3.0, 0.5),
            new FractionalRect(2.0 / 3.0, 0.5, 1.0 / 3.0, 0.5),
        }
    };

    // 8-up: 2 rows x 4 cols (YouTube-TV-multiview style).
    public static readonly LayoutDefinition EightUp = new()
    {
        Rows = 2,
        Cols = 4,
        VisibleCount = 8,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 1, 1),
            new SlotPlacement(0, 1, 1, 1),
            new SlotPlacement(0, 2, 1, 1),
            new SlotPlacement(0, 3, 1, 1),
            new SlotPlacement(1, 0, 1, 1),
            new SlotPlacement(1, 1, 1, 1),
            new SlotPlacement(1, 2, 1, 1),
            new SlotPlacement(1, 3, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 0.25, 0.5),
            new FractionalRect(0.25, 0.0, 0.25, 0.5),
            new FractionalRect(0.5, 0.0, 0.25, 0.5),
            new FractionalRect(0.75, 0.0, 0.25, 0.5),
            new FractionalRect(0.0, 0.5, 0.25, 0.5),
            new FractionalRect(0.25, 0.5, 0.25, 0.5),
            new FractionalRect(0.5, 0.5, 0.25, 0.5),
            new FractionalRect(0.75, 0.5, 0.25, 0.5),
        }
    };

    // Featured layout: one big panel (slot 0) + 4 small ones along the
    // side (slots 1-4). Only 5 of the 8 slots are visible in this preset;
    // slots 5-7 stay hidden.
    public static readonly LayoutDefinition FeaturedPlusFour = new()
    {
        Rows = 4,
        Cols = 3,
        VisibleCount = 5,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 4, 2), // featured: big block, left 2 cols, all 4 rows
            new SlotPlacement(0, 2, 1, 1),
            new SlotPlacement(1, 2, 1, 1),
            new SlotPlacement(2, 2, 1, 1),
            new SlotPlacement(3, 2, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 2.0 / 3.0, 1.0),
            new FractionalRect(2.0 / 3.0, 0.0, 1.0 / 3.0, 0.25),
            new FractionalRect(2.0 / 3.0, 0.25, 1.0 / 3.0, 0.25),
            new FractionalRect(2.0 / 3.0, 0.5, 1.0 / 3.0, 0.25),
            new FractionalRect(2.0 / 3.0, 0.75, 1.0 / 3.0, 0.25),
        }
    };

    // PiP (picture-in-picture): full screen slot 0 with corner inset slot 1.
    public static readonly LayoutDefinition Pip = new()
    {
        Rows = 1,
        Cols = 1,
        VisibleCount = 2,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 1, 1),
            new SlotPlacement(0, 0, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 1.0, 1.0),
            new FractionalRect(0.68, 0.68, 0.30, 0.30),
        }
    };

    // Split-3: 1 large left panel + 2 stacked right panels.
    public static readonly LayoutDefinition Split3 = new()
    {
        Rows = 2,
        Cols = 3,
        VisibleCount = 3,
        Placements = new[]
        {
            new SlotPlacement(0, 0, 2, 2),
            new SlotPlacement(0, 2, 1, 1),
            new SlotPlacement(1, 2, 1, 1),
        },
        FractionalPlacements = new[]
        {
            new FractionalRect(0.0, 0.0, 2.0 / 3.0, 1.0),
            new FractionalRect(2.0 / 3.0, 0.0, 1.0 / 3.0, 0.5),
            new FractionalRect(2.0 / 3.0, 0.5, 1.0 / 3.0, 0.5),
        }
    };

    public static LayoutDefinition ByCount(int n) => n switch
    {
        1 => OneUp,
        2 => TwoUp,
        3 => Split3,
        4 => FourUp,
        5 => FeaturedPlusFour,
        6 => SixUp,
        8 => EightUp,
        _ => FourUp,
    };

    public static LayoutDefinition ByName(string name) => name.ToLowerInvariant() switch
    {
        "1" or "1up" => OneUp,
        "2" or "2up" => TwoUp,
        "3" or "3split" or "split3" => Split3,
        "4" or "4up" => FourUp,
        "5" or "featured" or "featured5" => FeaturedPlusFour,
        "6" or "6up" => SixUp,
        "8" or "8up" => EightUp,
        "pip" => Pip,
        _ => FourUp,
    };

    public static IReadOnlyList<FractionalRect> GetFractionalRects(string layoutName) =>
        ByName(layoutName).FractionalPlacements;
}
