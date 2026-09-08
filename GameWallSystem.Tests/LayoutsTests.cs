using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

public class LayoutsTests
{
    [Theory]
    [InlineData("1", 1)]
    [InlineData("2", 2)]
    [InlineData("4", 4)]
    [InlineData("6", 6)]
    [InlineData("8", 8)]
    [InlineData("featured", 5)]
    [InlineData("pip", 2)]
    [InlineData("split3", 3)]
    public void GetFractionalRects_ReturnsExpectedSlotCount(string layoutName, int expectedCount)
    {
        var rects = Layouts.GetFractionalRects(layoutName);

        Assert.Equal(expectedCount, rects.Count);

        // Verify bounding limits: all coordinates must fall within [0, 1]
        foreach (var r in rects)
        {
            Assert.True(r.X >= 0, $"X should be >= 0, was {r.X}");
            Assert.True(r.Y >= 0, $"Y should be >= 0, was {r.Y}");
            Assert.True(r.Width > 0, $"Width should be > 0, was {r.Width}");
            Assert.True(r.Height > 0, $"Height should be > 0, was {r.Height}");
            Assert.True(r.X + r.Width <= 1.001, $"Right edge ({r.X + r.Width}) exceeds 1.0");
            Assert.True(r.Y + r.Height <= 1.001, $"Bottom edge ({r.Y + r.Height}) exceeds 1.0");
        }
    }

    [Fact]
    public void GetFractionalRects_FeaturedLayout_HasLargeMainSlot()
    {
        var rects = Layouts.GetFractionalRects("featured");

        Assert.Equal(5, rects.Count);

        // Slot 0 in featured layout should take 2/3 width and full height
        var main = rects[0];
        Assert.Equal(0, main.X);
        Assert.Equal(0, main.Y);
        Assert.True(main.Width > 0.65);
        Assert.True(main.Height > 0.99);

        // Side slots (1..4) should stack along the right 1/3
        for (int i = 1; i < 5; i++)
        {
            Assert.True(rects[i].X >= 0.65);
            Assert.True(rects[i].Width <= 0.35);
        }
    }

    [Fact]
    public void GetFractionalRects_PiPLayout_HasCornerOverlay()
    {
        var rects = Layouts.GetFractionalRects("pip");

        Assert.Equal(2, rects.Count);

        // Slot 0 is full screen
        Assert.Equal(1.0, rects[0].Width);
        Assert.Equal(1.0, rects[0].Height);

        // Slot 1 is bottom-right corner overlay
        Assert.True(rects[1].X > 0.5);
        Assert.True(rects[1].Y > 0.5);
        Assert.True(rects[1].Width < 0.5);
        Assert.True(rects[1].Height < 0.5);
    }

    [Fact]
    public void GetFractionalRects_DefaultsToFourUpForUnknown()
    {
        var rects = Layouts.GetFractionalRects("unknown-layout-name");
        Assert.Equal(4, rects.Count);
    }
}
