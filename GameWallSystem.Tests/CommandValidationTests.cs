using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

public class CommandValidationTests
{
    [Theory]
    [InlineData("https://www.espn.com/watch/", true)]
    [InlineData("http://localhost:5050/panel.html?gameId=1", true)]
    [InlineData("HTTPS://EXAMPLE.COM", true)]
    [InlineData("file:///C:/Windows/win.ini", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("data:text/html,<b>x</b>", false)]
    [InlineData("ms-settings:display", false)]
    [InlineData("www.espn.com", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsPlayableUrl_OnlyAllowsHttpAndHttps(string? url, bool expected)
    {
        Assert.Equal(expected, CommandRules.IsPlayableUrl(url));
    }

    [Fact]
    public void SanitizeCustomRects_ClampsHugeNegativeAndNonFiniteValues()
    {
        var rects = Layouts.SanitizeCustomRects(new[]
        {
            new CustomSlotRect { X = -5, Y = 0.25, Width = 1e308, Height = double.NaN },
            new CustomSlotRect { X = double.PositiveInfinity, Y = 2, Width = 0.5, Height = -1 },
            new CustomSlotRect { X = 0.5, Y = 0.5, Width = 0.25, Height = 0.25 },
        });

        Assert.Equal(3, rects.Length);
        foreach (var r in rects)
        {
            Assert.All(new[] { r.X, r.Y, r.Width, r.Height }, v => Assert.True(double.IsFinite(v) && v >= 0 && v <= 1));
            Assert.True(r.X + r.Width <= 1.0);
            Assert.True(r.Y + r.Height <= 1.0);
        }
        Assert.Equal(1.0, rects[0].Width);
        Assert.Equal(0.0, rects[0].Height);
        Assert.Equal(0.25, rects[2].Width);
    }

    [Fact]
    public void SanitizeCustomRects_KeepsAtMostEightAndKeepsSlotNumbersForNulls()
    {
        var input = Enumerable.Range(0, 12)
            .Select(i => i == 1 ? null : new CustomSlotRect { X = 0, Y = 0, Width = 0.1, Height = 0.1 })
            .ToArray();

        var rects = Layouts.SanitizeCustomRects(input);

        Assert.Equal(8, rects.Length);
        Assert.Equal(0.0, rects[1].Width);
        Assert.Equal(0.1, rects[2].Width);
    }

    [Fact]
    public void SanitizeCustomRects_NullInput_IsEmpty()
    {
        Assert.Empty(Layouts.SanitizeCustomRects(null));
    }
}
