using System.Text.Json;
using System.Text.Json.Nodes;

// Pin the content root to the folder the exe actually lives in, rather
// than relying on the process's working directory. Working directory
// isn't reliable here: `start "title" "path\to\exe"` in a batch file
// does NOT change into that exe's folder, so without this the app would
// look for wwwroot in whatever folder the launcher script happened to be
// run from and silently 404 on every request.
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
builder.Services.AddHttpClient();
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

// Load the editable network -> watch-URL mapping once at startup, but
// re-read on each schedule request is cheap enough and lets you edit
// networks.json without restarting the server.
string NetworksJsonPath() => Path.Combine(app.Environment.ContentRootPath, "networks.json");

Dictionary<string, string> LoadNetworkMap()
{
    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    try
    {
        var json = File.ReadAllText(NetworksJsonPath());
        var node = JsonNode.Parse(json)!.AsObject();
        foreach (var kvp in node)
        {
            if (kvp.Key.StartsWith('_')) continue;
            map[kvp.Key] = kvp.Value!.GetValue<string>();
        }
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning("Could not read networks.json: {Message}", ex.Message);
    }
    return map;
}

string DefaultWatchUrl()
{
    try
    {
        var json = File.ReadAllText(NetworksJsonPath());
        var node = JsonNode.Parse(json)!.AsObject();
        return node["_default"]?.GetValue<string>() ?? "https://www.espn.com/watch/";
    }
    catch
    {
        return "https://www.espn.com/watch/";
    }
}

app.MapGet("/api/schedule", async (IHttpClientFactory httpFactory) =>
{
    var client = httpFactory.CreateClient();
    client.Timeout = TimeSpan.FromSeconds(15);

    // ESPN's public scoreboard endpoint sits behind bot-protection that
    // will 403 requests that don't look like a real browser. A generic
    // .NET HttpClient User-Agent (or no Referer/Accept headers) gets
    // blocked; a full, current browser header set gets through.
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/plain, */*");
    client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en-US,en;q=0.9");
    client.DefaultRequestHeaders.Referrer = new Uri("https://www.espn.com/college-football/scoreboard");
    client.DefaultRequestHeaders.Add("Origin", "https://www.espn.com");

    var networkMap = LoadNetworkMap();
    var defaultUrl = DefaultWatchUrl();

    var now = DateTimeOffset.Now;
    var windowStart = now.AddHours(-12);   // still show games that just finished
    var windowEnd = now.AddDays(2);        // hide anything more than 2 days out

    var games = new List<object>();
    var seenIds = new HashSet<string>();
    string? fetchError = null;

    // One request covering the whole window (as a date range) rather than
    // four separate calls - fewer requests is both simpler and less likely
    // to trip rate-limiting/bot-protection than hammering the endpoint.
    var rangeStart = now.AddDays(-1).ToString("yyyyMMdd");
    var rangeEnd = now.AddDays(2).ToString("yyyyMMdd");
    var urls = new[]
    {
        $"https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates={rangeStart}-{rangeEnd}&groups=80&limit=300",
        $"https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates={rangeStart}-{rangeEnd}&groups=80&limit=300"
    };

    JsonNode? root = null;
    foreach (var url in urls)
    {
        try
        {
            var response = await client.GetAsync(url);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                fetchError = $"ESPN returned {(int)response.StatusCode} {response.StatusCode}";
                app.Logger.LogWarning("Schedule fetch failed for {Url}: {Error}. Body starts: {Snippet}",
                    url, fetchError, body.Length > 200 ? body[..200] : body);
                continue;
            }

            root = JsonNode.Parse(body);
            fetchError = null;
            break;
        }
        catch (Exception ex)
        {
            fetchError = ex.Message;
            app.Logger.LogWarning("Schedule fetch threw for {Url}: {Message}", url, ex.Message);
        }
    }

    var events = root?["events"]?.AsArray();
    if (events is not null)
    {
        foreach (var ev in events)
        {
            try
            {
                var id = ev!["id"]!.GetValue<string>();
                if (!seenIds.Add(id)) continue;

                var dateStr = ev["date"]!.GetValue<string>();
                var kickoff = DateTimeOffset.Parse(dateStr);
                if (kickoff < windowStart || kickoff > windowEnd) continue;

                var competition = ev["competitions"]![0];
                var competitors = competition!["competitors"]!.AsArray();

                var home = competitors.First(c => c!["homeAway"]!.GetValue<string>() == "home");
                var away = competitors.First(c => c!["homeAway"]!.GetValue<string>() == "away");

                string TeamName(JsonNode? c) => c!["team"]!["shortDisplayName"]?.GetValue<string>()
                    ?? c["team"]!["displayName"]!.GetValue<string>();
                int? Score(JsonNode? c) => c!["score"] is null ? null
                    : int.TryParse(c["score"]!.GetValue<string>(), out var s) ? s : null;

                var status = ev["status"]!["type"]!;
                var state = status["state"]?.GetValue<string>() ?? "pre";
                var detail = status["shortDetail"]?.GetValue<string>() ?? "";

                string? network = null;
                var broadcasts = competition["broadcasts"]?.AsArray();
                if (broadcasts is { Count: > 0 })
                {
                    var names = broadcasts[0]!["names"]?.AsArray();
                    if (names is { Count: > 0 })
                        network = names[0]!.GetValue<string>();
                }

                var eventUrl = ev["links"]?.AsArray()?
                    .Select(link => link?["href"]?.GetValue<string>())
                    .FirstOrDefault(link => link is not null &&
                        link.Contains("espn.com", StringComparison.OrdinalIgnoreCase));
                var mapped = network is not null && networkMap.TryGetValue(network, out var configured)
                    ? configured
                    : null;
                var watchUrl = eventUrl ?? mapped ?? defaultUrl;

                games.Add(new
                {
                    id,
                    kickoff = kickoff.ToString("O"),
                    homeTeam = TeamName(home),
                    awayTeam = TeamName(away),
                    homeScore = Score(home),
                    awayScore = Score(away),
                    state,
                    statusDetail = detail,
                    network = network ?? "TBD",
                    watchUrl,
                    watchUrlSource = eventUrl is not null ? "event" : mapped is not null ? "network" : "default",
                    requiresLogin = true
                });
            }
            catch (Exception ex)
            {
                app.Logger.LogWarning("Skipped one malformed event: {Message}", ex.Message);
            }
        }
    }

    var ordered = games.OrderBy(g => ((dynamic)g).kickoff).ToList();

    return Results.Json(new
    {
        games = ordered,
        sourceOk = fetchError is null,
        error = fetchError
    });
});

app.Run("http://0.0.0.0:5050");
