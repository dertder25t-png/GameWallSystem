using GameWallDisplayHost;
using Xunit;

namespace GameWallSystem.Tests;

public class RecoveryBackoffTests
{
    private static readonly DateTime T0 = new(2026, 10, 24, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void FirstFailure_ReloadsImmediately()
    {
        var backoff = new RecoveryBackoff();
        Assert.True(backoff.TryRecover(T0));
        Assert.Equal(1, backoff.Streak);
    }

    [Fact]
    public void RepeatedFailures_WaitTenTwentyFortySecondsThenCapAtFiveMinutes()
    {
        var backoff = new RecoveryBackoff();
        var now = T0;
        Assert.True(backoff.TryRecover(now));

        foreach (var seconds in new[] { 10, 20, 40, 80, 160, 300, 300, 300 })
        {
            Assert.False(backoff.TryRecover(now.AddSeconds(seconds - 1)));
            now = now.AddSeconds(seconds);
            Assert.True(backoff.TryRecover(now));
        }
    }

    [Fact]
    public void StillFailingAfterFiveMinutes_DoesNotResetTheStreak()
    {
        var backoff = new RecoveryBackoff();
        var now = T0;
        for (var i = 0; i < 7; i++)
        {
            now += backoff.CurrentWait;
            Assert.True(backoff.TryRecover(now));
        }
        Assert.Equal(RecoveryBackoff.MaxWait, backoff.CurrentWait);

        backoff.ReportUnhealthy();
        Assert.False(backoff.TryRecover(now.AddMinutes(4)));
        Assert.Equal(RecoveryBackoff.MaxWait, backoff.CurrentWait);
    }

    [Fact]
    public void HealthyForFiveMinutes_ResetsTheStreak()
    {
        var backoff = new RecoveryBackoff();
        backoff.TryRecover(T0);
        backoff.TryRecover(T0.AddSeconds(10));
        Assert.Equal(2, backoff.Streak);

        for (var s = 15; s <= 15 + 300; s += 5) backoff.ReportHealthy(T0.AddSeconds(s));

        Assert.Equal(0, backoff.Streak);
        Assert.True(backoff.TryRecover(T0.AddSeconds(321)));
    }

    [Fact]
    public void AFailedCheck_RestartsTheHealthyClock()
    {
        var backoff = new RecoveryBackoff();
        backoff.TryRecover(T0);
        backoff.ReportHealthy(T0.AddMinutes(1));
        backoff.ReportUnhealthy();
        backoff.ReportHealthy(T0.AddMinutes(4));
        backoff.ReportHealthy(T0.AddMinutes(6.5));

        Assert.Equal(1, backoff.Streak);
    }

    [Fact]
    public void Reset_AllowsAnImmediateReload()
    {
        var backoff = new RecoveryBackoff();
        backoff.TryRecover(T0);
        backoff.Reset();
        Assert.True(backoff.TryRecover(T0.AddSeconds(1)));
    }
}
