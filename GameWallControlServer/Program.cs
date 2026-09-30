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

JsonObject LoadNetworksData()
{
    var data = new JsonObject();
    try
    {
        var json = File.ReadAllText(NetworksJsonPath());
        data = JsonNode.Parse(json)!.AsObject();
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning("Could not read networks.json: {Message}", ex.Message);
    }
    return data;
}

string DefaultWatchUrl(JsonObject data)
{
    return data["default"]?.GetValue<string>() ?? "https://www.espn.com/watch/";
}

app.MapGet("/api/networks", () => Results.Json(LoadNetworksData()));

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
    client.DefaultRequestHeaders.Referrer = new Uri("https://www.espn.com/");
    client.DefaultRequestHeaders.Add("Origin", "https://www.espn.com");

    var networksData = LoadNetworksData();
    var networkEntries = networksData["networks"]?.AsObject();
    var priority = networksData["priority"]?.AsArray()
        .Select(value => value?.GetValue<string>())
        .Where(value => value is not null)
        .Select(value => value!)
        .ToList() ?? [];
    var defaultUrl = DefaultWatchUrl(networksData);

    (string Url, string Source) ResolveWatchUrl(string? network)
    {
        if (network is not null && networkEntries?[network] is JsonObject entry)
        {
            foreach (var serviceId in priority)
            {
                if (entry[serviceId]?.GetValue<string>() is { } url)
                    return (url, "network");
            }
        }
        return (defaultUrl, "default");
    }

    var now = DateTimeOffset.Now;
    // College football is a weekly sport: show from the start of the current game
    // week (games that finished in the last 12 hours stay visible) through the end
    // of NEXT week. The old "next 2 days" window hid Saturday's slate every
    // Monday-Wednesday, which is why games seemed to be missing mid-week.
    var windowStart = now.AddHours(-12);
    var windowEnd = EndOfNextGameWeek(now);

    var games = new List<object>();
    var seenIds = new HashSet<string>();
    string? fetchError = null;

    var rangeStart = now.AddDays(-1).ToString("yyyyMMdd");
    var rangeEnd = windowEnd.ToString("yyyyMMdd");
    var endpoints = new[]
    {
        (sport: "football", url: $"https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates={rangeStart}-{rangeEnd}&groups=80&limit=300"),
        (sport: "mma", url: "https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard"),
        (sport: "nascar", url: "https://site.web.api.espn.com/apis/site/v2/sports/racing/nascar-premier/scoreboard"),
        (sport: "f1", url: "https://site.web.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard")
    };

    async Task<(string Sport, JsonNode? Root, string? Error)> FetchEndpointAsync((string sport, string url) endpoint)
    {
        try
        {
            var response = await client.GetAsync(endpoint.url);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                var fallbackUrl = endpoint.url.Contains("site.web.api.espn.com")
                    ? endpoint.url.Replace("site.web.api.espn.com", "site.api.espn.com")
                    : endpoint.url.Replace("site.api.espn.com", "site.web.api.espn.com");

                try
                {
                    var fallbackResponse = await client.GetAsync(fallbackUrl);
                    if (fallbackResponse.IsSuccessStatusCode)
                    {
                        var fallbackBody = await fallbackResponse.Content.ReadAsStringAsync();
                        return (endpoint.sport, JsonNode.Parse(fallbackBody), null);
                    }
                }
                catch { }

                var error = $"ESPN returned {(int)response.StatusCode} {response.StatusCode}";
                app.Logger.LogWarning("Schedule fetch failed for {Url}: {Error}. Body starts: {Snippet}",
                    endpoint.url, error, body.Length > 200 ? body[..200] : body);
                return (endpoint.sport, null, error);
            }

            return (endpoint.sport, JsonNode.Parse(body), null);
        }
        catch (Exception ex)
        {
            app.Logger.LogWarning("Schedule fetch threw for {Url}: {Message}", endpoint.url, ex.Message);
            return (endpoint.sport, null, ex.Message);
        }
    }

    var results = await Task.WhenAll(endpoints.Select(FetchEndpointAsync));
    var successfulFetches = 0;
    foreach (var result in results)
    {
        if (result.Root is not null) successfulFetches++;
        else if (result.Error is not null) fetchError ??= result.Error;
        var events = result.Root?["events"]?.AsArray();
        if (events is null) continue;

        foreach (var ev in events)
        {
            try
            {
                var eventId = ev!["id"]!.GetValue<string>();

                var dateStr = ev["date"]!.GetValue<string>();
                var kickoff = DateTimeOffset.Parse(dateStr);
                var isCurrentSportEvent = result.Sport != "football";
                var inWindow = isCurrentSportEvent
                    ? (kickoff >= now.AddDays(-5) && kickoff <= now.AddDays(7))
                    : (kickoff >= windowStart && kickoff <= windowEnd);
                if (!inWindow) continue;

                string TeamName(JsonNode? c) => c?["team"]?["shortDisplayName"]?.GetValue<string>()
                    ?? c?["team"]?["displayName"]?.GetValue<string>()
                    ?? c?["athlete"]?["shortName"]?.GetValue<string>()
                    ?? c?["athlete"]?["displayName"]?.GetValue<string>()
                    ?? "Unknown competitor";
                string? TeamLogo(JsonNode? c) =>
                    c?["team"]?["logos"]?.AsArray()?.Select(logo => logo?["href"]?.GetValue<string>()).FirstOrDefault(href => !string.IsNullOrWhiteSpace(href))
                    ?? c?["athlete"]?["flag"]?["href"]?.GetValue<string>()
                    ?? c?["athlete"]?["headshot"]?["href"]?.GetValue<string>();
                int? Score(JsonNode? c) => c!["score"] is null ? null
                    : int.TryParse(c["score"]!.GetValue<string>(), out var s) ? s : null;

                var status = ev["status"]!["type"]!;
                var state = status["state"]?.GetValue<string>() ?? "pre";
                var detail = status["shortDetail"]?.GetValue<string>() ?? "";

                string watchUrl, watchUrlSource;

                if (result.Sport == "mma")
                {
                    var bouts = ev["competitions"]?.AsArray();
                    if (bouts is null) continue;
                    for (var boutIndex = 0; boutIndex < bouts.Count; boutIndex++)
                    {
                        var bout = bouts[boutIndex];
                        var boutCompetitors = bout?["competitors"]?.AsArray();
                        if (boutCompetitors is null || boutCompetitors.Count < 2) continue;
                        var first = boutCompetitors[0];
                        var second = boutCompetitors[1];
                        var boutId = $"{eventId}-{boutIndex}";
                        if (!seenIds.Add(boutId)) continue;

                        var boutStatus = bout?["status"]?["type"];
                        var boutState = boutStatus?["state"]?.GetValue<string>() ?? state;
                        var boutDetail = boutStatus?["shortDetail"]?.GetValue<string>() ?? detail;

                        string? boutNetwork = null;
                        var boutBroadcasts = bout?["broadcasts"]?.AsArray();
                        if (boutBroadcasts is { Count: > 0 })
                        {
                            var names = boutBroadcasts[0]?["names"]?.AsArray();
                            if (names is { Count: > 0 })
                                boutNetwork = names[0]?.GetValue<string>();
                        }
                        boutNetwork ??= bout?["broadcast"]?.GetValue<string>() ?? "ESPN+";
                        (watchUrl, watchUrlSource) = ResolveWatchUrl(boutNetwork);

                        games.Add(new
                        {
                            id = boutId,
                            sport = result.Sport,
                            kickoff = kickoff.ToString("O"),
                            homeTeam = TeamName(first),
                            awayTeam = TeamName(second),
                            homeLogo = TeamLogo(first),
                            awayLogo = TeamLogo(second),
                            homeScore = Score(first),
                            awayScore = Score(second),
                            state = boutState,
                            statusDetail = boutDetail,
                            network = boutNetwork,
                            watchUrl,
                            watchUrlSource,
                            requiresLogin = true,
                            isRace = false
                        });
                    }
                    continue;
                }

                if (result.Sport == "nascar")
                {
                    if (!seenIds.Add(eventId)) continue;
                    var comp = ev["competitions"]?[0];
                    var nascarCompetitors = comp?["competitors"]?.AsArray() ?? [];
                    var leader = nascarCompetitors.OrderBy(c => c?["order"]?.GetValue<int>() ?? int.MaxValue).FirstOrDefault();
                    var leaderName = leader?["athlete"]?["displayName"]?.GetValue<string>()
                        ?? leader?["team"]?["displayName"]?.GetValue<string>();

                    string? nascarNetwork = null;
                    var nascarBroadcasts = comp?["broadcasts"]?.AsArray();
                    if (nascarBroadcasts is { Count: > 0 })
                    {
                        var names = nascarBroadcasts[0]?["names"]?.AsArray();
                        if (names is { Count: > 0 })
                            nascarNetwork = names[0]?.GetValue<string>();
                    }
                    nascarNetwork ??= "ESPN";
                    (watchUrl, watchUrlSource) = ResolveWatchUrl(nascarNetwork);

                    var compStatus = comp?["status"]?["type"];
                    var raceState = compStatus?["state"]?.GetValue<string>() ?? state;
                    var raceDetail = compStatus?["shortDetail"]?.GetValue<string>() ?? detail;

                    games.Add(new
                    {
                        id = eventId,
                        sport = result.Sport,
                        kickoff = kickoff.ToString("O"),
                        homeTeam = ev["name"]?.GetValue<string>() ?? ev["shortName"]?.GetValue<string>() ?? "NASCAR Cup Series",
                        awayTeam = "",
                        homeLogo = (string?)null,
                        awayLogo = (string?)null,
                        homeScore = (int?)null,
                        awayScore = (int?)null,
                        state = raceState,
                        statusDetail = string.IsNullOrWhiteSpace(leaderName) ? raceDetail : $"Leader: {leaderName} · {raceDetail}",
                        network = nascarNetwork,
                        watchUrl,
                        watchUrlSource,
                        requiresLogin = true,
                        isRace = true
                    });
                    continue;
                }

                if (result.Sport == "f1")
                {
                    if (!seenIds.Add(eventId)) continue;
                    var comps = ev["competitions"]?.AsArray();
                    var comp = comps?.FirstOrDefault(c =>
                        string.Equals(c?["type"]?["abbreviation"]?.GetValue<string>(), "Race", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(c?["type"]?["id"]?.GetValue<string>(), "3", StringComparison.OrdinalIgnoreCase))
                        ?? comps?.FirstOrDefault(c => string.Equals(c?["status"]?["type"]?["state"]?.GetValue<string>(), "in", StringComparison.OrdinalIgnoreCase))
                        ?? comps?.LastOrDefault()
                        ?? ev["competitions"]?[0];

                    var sessionType = comp?["type"]?["abbreviation"]?.GetValue<string>() ?? "Race";
                    var compStatus = comp?["status"]?["type"];
                    var raceState = compStatus?["state"]?.GetValue<string>() ?? state;
                    var raceDetail = compStatus?["shortDetail"]?.GetValue<string>() ?? detail;

                    var f1Competitors = comp?["competitors"]?.AsArray() ?? [];
                    var leader = f1Competitors.OrderBy(c => c?["order"]?.GetValue<int>() ?? int.MaxValue).FirstOrDefault();
                    var leaderName = leader?["athlete"]?["displayName"]?.GetValue<string>()
                        ?? leader?["team"]?["displayName"]?.GetValue<string>();

                    string? f1Network = null;
                    var f1Broadcasts = comp?["broadcasts"]?.AsArray();
                    if (f1Broadcasts is { Count: > 0 })
                    {
                        var names = f1Broadcasts[0]?["names"]?.AsArray();
                        if (names is { Count: > 0 })
                            f1Network = names[0]?.GetValue<string>();
                    }
                    f1Network ??= "ESPN";
                    (watchUrl, watchUrlSource) = ResolveWatchUrl(f1Network);

                    var eventName = ev["name"]?.GetValue<string>() ?? ev["shortName"]?.GetValue<string>() ?? "Formula 1";
                    var title = string.Equals(sessionType, "Race", StringComparison.OrdinalIgnoreCase)
                        ? eventName
                        : $"{eventName} ({sessionType})";

                    var compDateStr = comp?["date"]?.GetValue<string>();
                    var f1Kickoff = (compDateStr is not null && DateTimeOffset.TryParse(compDateStr, out var parsedF1Date)) ? parsedF1Date : kickoff;

                    games.Add(new
                    {
                        id = eventId,
                        sport = result.Sport,
                        kickoff = f1Kickoff.ToString("O"),
                        homeTeam = title,
                        awayTeam = "",
                        homeLogo = (string?)null,
                        awayLogo = (string?)null,
                        homeScore = (int?)null,
                        awayScore = (int?)null,
                        state = raceState,
                        statusDetail = string.IsNullOrWhiteSpace(leaderName) ? raceDetail : $"Leader: {leaderName} · {raceDetail}",
                        network = f1Network,
                        watchUrl,
                        watchUrlSource,
                        requiresLogin = true,
                        isRace = true
                    });
                    continue;
                }

                if (!seenIds.Add(eventId)) continue;
                var competition = ev["competitions"]?[0];
                if (competition is null) continue;
                var competitors = competition["competitors"]?.AsArray();
                if (competitors is null || competitors.Count < 2) continue;
                var home = competitors.First(c => c!["homeAway"]!.GetValue<string>() == "home");
                var away = competitors.First(c => c!["homeAway"]!.GetValue<string>() == "away");

                string? network = null;
                var broadcasts = competition["broadcasts"]?.AsArray();
                if (broadcasts is { Count: > 0 })
                {
                    var names = broadcasts[0]!["names"]?.AsArray();
                    if (names is { Count: > 0 })
                        network = names[0]!.GetValue<string>();
                }

                (watchUrl, watchUrlSource) = ResolveWatchUrl(network);

                object? weatherObj = null;
                var evWeather = ev["weather"];
                if (evWeather is not null)
                {
                    weatherObj = new
                    {
                        displayValue = evWeather["displayValue"]?.GetValue<string>(),
                        temperature = evWeather["temperature"]?.GetValue<int>(),
                        highTemperature = evWeather["highTemperature"]?.GetValue<int>(),
                        conditionId = evWeather["conditionId"]?.GetValue<string>()
                    };
                }

                object? oddsObj = null;
                var compOdds = competition["odds"]?.AsArray();
                if (compOdds is { Count: > 0 } && compOdds[0] is JsonObject firstOdds)
                {
                    oddsObj = new
                    {
                        details = firstOdds["details"]?.GetValue<string>(),
                        overUnder = firstOdds["overUnder"]?.GetValue<double>(),
                        spread = firstOdds["spread"]?.GetValue<double>()
                    };
                }

                object? situationObj = null;
                var compSit = competition["situation"];
                if (compSit is not null)
                {
                    situationObj = new
                    {
                        downDistanceText = compSit["downDistanceText"]?.GetValue<string>(),
                        possessionText = compSit["possessionText"]?.GetValue<string>(),
                        lastPlay = compSit["lastPlay"]?["text"]?.GetValue<string>()
                    };
                }

                games.Add(new
                {
                    id = eventId,
                    sport = result.Sport,
                    kickoff = kickoff.ToString("O"),
                    homeTeam = TeamName(home),
                    awayTeam = TeamName(away),
                    homeLogo = TeamLogo(home),
                    awayLogo = TeamLogo(away),
                    homeScore = Score(home),
                    awayScore = Score(away),
                    state,
                    statusDetail = detail,
                    network = network ?? "TBD",
                    watchUrl,
                    watchUrlSource,
                    requiresLogin = true,
                    isRace = false,
                    weather = weatherObj,
                    odds = oddsObj,
                    situation = situationObj
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
        sourceOk = successfulFetches > 0,
        error = fetchError
    });
});

app.MapGet("/api/panel-data", async (string gameId, string? sport, IHttpClientFactory httpFactory) =>
{
    if (string.IsNullOrWhiteSpace(gameId))
        return Results.BadRequest(new { error = "gameId is required" });

    var client = httpFactory.CreateClient();
    client.Timeout = TimeSpan.FromSeconds(10);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json, text/plain, */*");
    client.DefaultRequestHeaders.Referrer = new Uri("https://www.espn.com/");
    client.DefaultRequestHeaders.Add("Origin", "https://www.espn.com");

    sport = (sport ?? "football").ToLowerInvariant();
    var rawEventId = gameId.Contains('-') ? gameId.Split('-')[0] : gameId;

    string summaryUrl = sport switch
    {
        "mma" => $"https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc/summary?event={rawEventId}",
        "nascar" => $"https://site.web.api.espn.com/apis/site/v2/sports/racing/nascar-premier/summary?event={rawEventId}",
        "f1" => $"https://site.web.api.espn.com/apis/site/v2/sports/racing/f1/summary?event={rawEventId}",
        _ => $"https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/summary?event={rawEventId}"
    };

    try
    {
        var response = await client.GetAsync(summaryUrl);
        if (!response.IsSuccessStatusCode)
        {
            var fallbackUrl = summaryUrl.Contains("site.web.api.espn.com")
                ? summaryUrl.Replace("site.web.api.espn.com", "site.api.espn.com")
                : summaryUrl.Replace("site.api.espn.com", "site.web.api.espn.com");
            response = await client.GetAsync(fallbackUrl);
        }

        if (response.IsSuccessStatusCode)
        {
            var json = await response.Content.ReadAsStringAsync();
            var node = JsonNode.Parse(json);
            if (node is not null)
            {
                var header = node["header"];
                var predictor = node["predictor"];
                var winProbList = node["winprobability"]?.AsArray();
                var gameInfo = node["gameInfo"];
                var leaders = node["leaders"]?.AsArray();
                var boxscore = node["boxscore"];
                var odds = node["odds"]?.AsArray()?[0];

                double? homeWinPercentage = null;
                double? awayWinPercentage = null;

                if (predictor?["homeTeam"]?["gameProjection"] is { } hProj)
                {
                    if (double.TryParse(hProj.ToString(), out var hp))
                        homeWinPercentage = hp;
                }
                if (predictor?["awayTeam"]?["gameProjection"] is { } aProj)
                {
                    if (double.TryParse(aProj.ToString(), out var ap))
                        awayWinPercentage = ap;
                }

                if (winProbList is { Count: > 0 })
                {
                    var lastPoint = winProbList[^1];
                    if (lastPoint?["homeWinPercentage"] is { } liveHw)
                    {
                        if (double.TryParse(liveHw.ToString(), out var liveVal))
                        {
                            homeWinPercentage = liveVal > 1.0 ? liveVal : liveVal * 100.0;
                            awayWinPercentage = 100.0 - homeWinPercentage;
                        }
                    }
                }

                var probHistory = new List<object>();
                if (winProbList is { Count: > 0 })
                {
                    int step = Math.Max(1, winProbList.Count / 20);
                    for (int i = 0; i < winProbList.Count; i += step)
                    {
                        var pt = winProbList[i];
                        if (pt?["homeWinPercentage"] is { } hwp && double.TryParse(hwp.ToString(), out var val))
                        {
                            probHistory.Add(new
                            {
                                homeWin = val > 1.0 ? val : val * 100.0,
                                playId = pt["playId"]?.GetValue<string>()
                            });
                        }
                    }
                }

                return Results.Json(new
                {
                    gameId,
                    sport,
                    header,
                    winProbability = new
                    {
                        homeWinPercentage,
                        awayWinPercentage,
                        history = probHistory
                    },
                    predictor,
                    gameInfo,
                    leaders,
                    boxscore,
                    odds,
                    sourceOk = true
                });
            }
        }
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning("Panel data fetch failed for {Id}: {Message}", gameId, ex.Message);
    }

    return Results.Json(new
    {
        gameId,
        sport,
        sourceOk = false,
        message = "Live summary not currently active for this event."
    });
});

// Local remote: this PC only by default. Pass --lan to let phones on the same Wi-Fi in
// (the old behaviour). Paired phones normally use GameDay's Wall tab over the internet.
var lan = args.Any(a => string.Equals(a, "--lan", StringComparison.OrdinalIgnoreCase));
app.Run(lan ? "http://0.0.0.0:5050" : "http://localhost:5050");

// Game weeks run Tuesday through Monday (Monday-night games belong to the weekend before).
static DateTimeOffset EndOfNextGameWeek(DateTimeOffset now)
{
    var daysUntilMonday = ((int)DayOfWeek.Monday - (int)now.DayOfWeek + 7) % 7;
    var thisWeekEnd = now.Date.AddDays(daysUntilMonday).AddDays(1); // start of Tuesday
    return new DateTimeOffset(thisWeekEnd.AddDays(7), now.Offset);
}
