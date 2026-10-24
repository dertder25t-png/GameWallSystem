namespace GameWallDisplayHost;

/// <summary>
/// Decides when a failing slot may be reloaded: right away the first time, then 10 s,
/// 20 s, 40 s … up to 5 min between reloads, so a stream that can't play doesn't get
/// restarted every few seconds. A slot that stays healthy for 5 minutes starts over.
/// </summary>
public sealed class RecoveryBackoff
{
    public static readonly TimeSpan FirstWait = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan MaxWait = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan HealthyResetAfter = TimeSpan.FromMinutes(5);

    private DateTime _lastRecovery = DateTime.MinValue;
    private DateTime? _healthySince;

    /// <summary>Reloads since the slot was last healthy for <see cref="HealthyResetAfter"/>.</summary>
    public int Streak { get; private set; }

    /// <summary>How long after the last reload the next one is allowed.</summary>
    public TimeSpan CurrentWait => Streak == 0
        ? TimeSpan.Zero
        : TimeSpan.FromSeconds(Math.Min(MaxWait.TotalSeconds, FirstWait.TotalSeconds * Math.Pow(2, Streak - 1)));

    /// <summary>Returns true, and counts the reload, if the slot may be reloaded now.</summary>
    public bool TryRecover(DateTime now)
    {
        _healthySince = null;
        if (now - _lastRecovery < CurrentWait) return false;
        Streak++;
        _lastRecovery = now;
        return true;
    }

    /// <summary>A health check passed. Enough of them in a row resets the streak.</summary>
    public void ReportHealthy(DateTime now)
    {
        _healthySince ??= now;
        if (Streak > 0 && now - _healthySince.Value >= HealthyResetAfter) Streak = 0;
    }

    /// <summary>A health check failed: the healthy run starts over.</summary>
    public void ReportUnhealthy() => _healthySince = null;

    /// <summary>The phone loaded something new into the slot.</summary>
    public void Reset()
    {
        Streak = 0;
        _healthySince = null;
        _lastRecovery = DateTime.MinValue;
    }
}
