using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using StockChartsMvc.Models;

namespace StockChartsMvc.Controllers;

public class HomeController : Controller
{
    private static readonly IReadOnlyDictionary<string, string> IndexConstituentFiles =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["nifty50"] = "ind_nifty50list.csv",
            ["niftynext50"] = "ind_niftynext50list.csv",
            ["nifty100"] = "ind_nifty100list.csv",
            ["nifty200"] = "ind_nifty200list.csv",
            ["nifty500"] = "ind_nifty500list.csv",
            ["niftyipo"] = "ind_niftyIPO_list.csv",
            ["niftylargemidcap250"] = "ind_niftylargemidcap250list.csv",
            ["niftymidsmallcap400"] = "ind_niftymidsmallcap400list.csv",
            ["niftymicrocap250"] = "ind_niftymicrocap250_list.csv",
            ["niftytotalmarket"] = "ind_niftytotalmarket_list.csv",
            ["niftymidcap50"] = "ind_niftymidcap50list.csv",
            ["niftymidcap100"] = "ind_niftymidcap100list.csv",
            ["niftymidcap150"] = "ind_niftymidcap150list.csv",
            ["niftysmallcap50"] = "ind_niftysmallcap50list.csv",
            ["niftysmallcap100"] = "ind_niftysmallcap100list.csv",
            ["niftysmallcap250"] = "ind_niftysmallcap250list.csv",
            ["niftybank"] = "ind_niftybanklist.csv",
            ["niftyfinancialservices"] = "ind_niftyfinancialserviceslist.csv",
            ["niftyit"] = "ind_niftyitlist.csv",
            ["niftyauto"] = "ind_niftyautolist.csv",
            ["niftyfmcg"] = "ind_niftyfmcglist.csv",
            ["niftypharma"] = "ind_niftypharmalist.csv",
            ["niftymetal"] = "ind_niftymetallist.csv",
            ["niftymedia"] = "ind_niftymedialist.csv",
            ["niftyrealty"] = "ind_niftyrealtylist.csv",
            ["niftyenergy"] = "ind_niftyenergylist.csv",
            ["niftypsubank"] = "ind_niftypsubanklist.csv",
            ["niftyprivatebank"] = "ind_niftyprivatebanklist.csv",
            ["niftyhealthcare"] = "ind_niftyhealthcarelist.csv",
            ["niftyconsumerdurables"] = "ind_niftyconsumerdurableslist.csv",
            ["niftyoilgas"] = "ind_niftyoilgaslist.csv",
            ["niftyfinancialservices2550"] = "ind_niftyfinancialservices2550list.csv",
            ["niftyfinancialservicesexbank"] = "ind_niftyfinancialservicesexbanklist.csv",
            ["niftychemicals"] = "ind_niftychemicalslist.csv",
            ["niftycapitalmarkets"] = "ind_niftycapitalmarketslist.csv",
            ["niftycommodities"] = "ind_niftycommoditieslist.csv",
            ["niftyconsumption"] = "ind_niftyconsumptionlist.csv",
            ["niftycpse"] = "ind_niftycpselist.csv",
            ["niftyinfrastructure"] = "ind_niftyinfralist.csv",
            ["niftypse"] = "ind_niftypselist.csv",
            ["niftyservicessector"] = "ind_niftyservsectorlist.csv",
            ["niftymnc"] = "ind_niftymnclist.csv",
            ["niftyhousing"] = "ind_niftyhousinglist.csv",
            ["niftyindiadefence"] = "ind_niftyindiadefencelist.csv",
            ["niftyindiadigital"] = "ind_niftyindiadigitallist.csv",
            ["niftyindiatourism"] = "ind_niftyindiatourismlist.csv",
            ["niftyindiamanufacturing"] = "ind_niftyindiamanufacturinglist.csv",
            ["niftyrural"] = "ind_niftyrurallist.csv",
            ["niftyindiafpi150"] = "ind_niftyIndiaFPI150_list.csv",
            ["niftymidcapselect"] = "ind_niftymidcapselect_list.csv",
            ["niftymidsmallcap4005050"] = "ind_niftyMidSmallcap4005050_list.csv",
            ["niftynext100"] = "ind_niftyNext100_list.csv",
            ["niftysmallcap500"] = "ind_NiftySmallcap500_list.csv",
            ["nifty500largemidsmallequalcapweighted"] = "ind_nifty500LargeMidSmallEqualCapWeighted_list.csv",
            ["nifty500multicap502525"] = "ind_nifty500Multicap502525_list.csv",
            ["niftycapitalgoods"] = "ind_niftyCapitalGoods_list.csv",
            ["niftycement"] = "ind_NiftyCement_list.csv",
            ["niftycommercialtransportservices"] = "ind_niftyCommercialTransportServices_list.csv",
            ["niftyconstruction"] = "ind_niftyConstruction_list.csv",
            ["niftyconsumerservices"] = "ind_niftyConsumerServices_list.csv",
            ["niftyhospitals"] = "ind_niftyHospitals_list.csv",
            ["niftyhousingfinance"] = "ind_niftyHousingFinance_list.csv",
            ["niftyinsurance"] = "ind_niftyInsurance_list.csv",
            ["niftymidsmallfinancialservices"] = "ind_niftymidsmallfinancailservice_list.csv",
            ["niftymidsmallhealthcare"] = "ind_niftymidsmallhealthcare_list.csv",
            ["niftymidsmallittelecom"] = "ind_niftymidsmallitAndtelecom_list.csv",
            ["niftynbfc"] = "ind_niftyNBFC_list.csv",
            ["niftypower"] = "ind_niftyPower_list.csv",
            ["niftyreitsrealty"] = "ind_niftyREITsRealty_list.csv",
            ["niftyretail"] = "ind_niftyRetail_list.csv",
            ["niftytelecommunications"] = "ind_niftyTelecommunications_list.csv",
            ["nifty500healthcare"] = "ind_nifty500Healthcare_list.csv",
            ["niftyaicatalysts"] = "ind_niftyAICatalystslist.csv",
            ["niftyconglomerate50"] = "ind_niftyConglomerate50_list.csv",
            ["niftycorehousing"] = "ind_niftyCoreHousing_list.csv",
            ["niftyadityabirlacorporategroup"] = "ind_nifty_adityabirlalist.csv",
            ["niftymahindracorporategroup"] = "ind_nifty_mahindralist.csv",
            ["niftytatacorporategroup"] = "ind_nifty_tatalist.csv",
            ["niftytata25cap"] = "ind_nifty_tata25caplist.csv",
            ["niftyindiadefenceequalweight"] = "ind_niftyIndiaDefenceEqualWeight_list.csv",
            ["niftyindiainfrastructurelogistics"] = "ind_niftyIndiaInfrastructure_Logistics_list.csv",
            ["niftyindiainternet"] = "ind_niftyIndiaInternet_list.csv",
            ["niftyindiarailwayspsu"] = "ind_niftyIndiaRailwaysPSU_list.csv",
            ["niftyindiaselect5corporategroups"] = "ind_niftyIndiaSelect5CorporateGroupsMAATR_list.csv",
            ["niftymidcapliquid15"] = "ind_Nifty_Midcap_Liquid15.csv",
            ["niftymidsmallindiaconsumption"] = "ind_niftymidsmallindiaconsumption_list.csv",
            ["niftymobility"] = "ind_niftymobility_list.csv",
            ["niftynoncyclicalconsumer"] = "ind_niftynon-cyclicalconsumer_list.csv",
            ["niftyreitsinvit"] = "ind_niftyREITs_InvITs_list.csv",
            ["niftyreitsinvit9010"] = "ind_niftyREITsInvITs9010list.csv",
            ["niftysmallfinancebanksmicrofinance"] = "ind_niftySFBsMfis_list.csv",
            ["niftysmeemerge"] = "ind_niftysmelist.csv",
            ["niftysugarandethanol"] = "ind_niftySugarEthanol_list.csv",
            ["niftywaves"] = "ind_niftyWaves_list.csv",
            ["nifty100liquid15"] = "ind_Nifty100_Liquid15.csv",
            ["nifty500multicapindiamanufacturing503020"] = "ind_nifty500MulticapIndiaManufacturing503020_list.csv",
            ["nifty500multicapinfrastructure503020"] = "ind_nifty500MulticapInfrastructure503020_list.csv",
            ["niftyindiaevnewageautomotive"] = "ind_niftyEv_NewAgeAutomotive_list.csv",
            ["niftyindianewageconsumption"] = "ind_niftyIndiaNewAgeConsumption_list.csv",
            ["niftytransportationandlogistics"] = "ind_niftytransportationandlogistics%20_list.csv"
        };

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<HomeController> _logger;

    public HomeController(IHttpClientFactory httpClientFactory, ILogger<HomeController> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public IActionResult Index()
    {
        return View();
    }

    public IActionResult Privacy()
    {
        return View();
    }

    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error()
    {
        return View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
    }

    /// <summary>
    /// Proxy endpoint to fetch quote metadata from Yahoo Finance for one or more symbols.
    /// This bypasses CORS issues by making the request server-side.
    /// </summary>
    [HttpGet("api/quote-data")]
    public async Task<IActionResult> GetQuoteData(string symbols)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(symbols))
            {
                return BadRequest(new { error = "Missing required parameter: symbols" });
            }

            var yahooUrl = $"https://query1.finance.yahoo.com/v2/finance/quote?symbols={Uri.EscapeDataString(symbols)}";
            _logger.LogInformation($"Fetching quote data for {symbols} from Yahoo Finance");

            using (var client = _httpClientFactory.CreateClient())
            {
                client.Timeout = TimeSpan.FromSeconds(15);
                client.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

                var response = await client.GetAsync(yahooUrl);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogError($"Yahoo Finance returned status code: {response.StatusCode}");
                    return StatusCode((int)response.StatusCode, new { error = "Failed to fetch quote data from Yahoo Finance" });
                }

                var jsonContent = await response.Content.ReadAsStringAsync();
                var jsonData = JsonSerializer.Deserialize<JsonElement>(jsonContent);

                return Ok(jsonData);
            }
        }
        catch (HttpRequestException ex)
        {
            _logger.LogError($"HTTP request error: {ex.Message}");
            return StatusCode(500, new { error = "Network error while fetching quote data" });
        }
        catch (TaskCanceledException ex)
        {
            _logger.LogError($"Request timeout: {ex.Message}");
            return StatusCode(408, new { error = "Request timeout" });
        }
        catch (Exception ex)
        {
            _logger.LogError($"Unexpected error: {ex.Message}");
            return StatusCode(500, new { error = "Internal server error" });
        }
    }

    [HttpGet("api/nifty500-symbols")]
    public Task<IActionResult> GetNifty500Symbols()
    {
        return LoadIndexSymbolsAsync("nifty500", HttpContext.RequestAborted);
    }

    [HttpGet("api/index-symbols")]
    public Task<IActionResult> GetIndexSymbols([FromQuery] string index, CancellationToken cancellationToken)
    {
        return LoadIndexSymbolsAsync(index, cancellationToken);
    }

    private async Task<IActionResult> LoadIndexSymbolsAsync(string index, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(index) || !IndexConstituentFiles.TryGetValue(index, out var fileName))
        {
            return BadRequest(new { error = "Unsupported index selection" });
        }

        try
        {
            var csvUrl = $"https://www.niftyindices.com/IndexConstituent/{fileName}";
            using var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(15);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0");

            var csv = await client.GetStringAsync(csvUrl, cancellationToken);
            var lines = csv.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
            if (lines.Length < 2)
            {
                return StatusCode(502, new { error = "NSE returned an empty index constituent list" });
            }

            var symbols = lines.Skip(1)
                .Select(ParseCsvLine)
                .Where(fields => fields.Count >= 3 && !string.IsNullOrWhiteSpace(fields[2]))
                .Select(fields => new
                {
                    s = fields[2].Trim(),
                    n = fields[0].Trim(),
                    i = fields[1].Trim()
                })
                .ToList();

            return Ok(symbols);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Unable to fetch index constituents for {Index} from NSE", index);
            return StatusCode(502, new { error = "Unable to fetch the selected NSE index constituents" });
        }
    }

    private static List<string> ParseCsvLine(string line)
    {
        var fields = new List<string>();
        var field = new System.Text.StringBuilder();
        var quoted = false;

        for (var i = 0; i < line.Length; i++)
        {
            var character = line[i];
            if (character == '"')
            {
                if (quoted && i + 1 < line.Length && line[i + 1] == '"')
                {
                    field.Append('"');
                    i++;
                }
                else
                {
                    quoted = !quoted;
                }
            }
            else if (character == ',' && !quoted)
            {
                fields.Add(field.ToString());
                field.Clear();
            }
            else
            {
                field.Append(character);
            }
        }

        fields.Add(field.ToString());
        return fields;
    }

    /// <summary>
    /// Proxy endpoint to fetch chart data from Yahoo Finance API.
    /// This bypasses CORS issues by making the request server-side.
    /// </summary>
    [HttpGet("api/chart-data")]
    public async Task<IActionResult> GetChartData(string symbol, string interval, string range)
    {
        try
        {
            if (string.IsNullOrEmpty(symbol) || string.IsNullOrEmpty(interval) || string.IsNullOrEmpty(range))
            {
                return BadRequest(new { error = "Missing required parameters: symbol, interval, range" });
            }

            // Build Yahoo Finance URL
            var yahooUrl = $"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval={interval}&range={range}&includePrePost=false";

            _logger.LogInformation($"Fetching chart data for {symbol} from Yahoo Finance");

            using (var client = _httpClientFactory.CreateClient())
            {
                client.Timeout = TimeSpan.FromSeconds(15);
                client.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

                var response = await client.GetAsync(yahooUrl);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogError($"Yahoo Finance returned status code: {response.StatusCode}");
                    return StatusCode((int)response.StatusCode, new { error = "Failed to fetch data from Yahoo Finance" });
                }

                var jsonContent = await response.Content.ReadAsStringAsync();
                var jsonData = JsonSerializer.Deserialize<JsonElement>(jsonContent);

                return Ok(jsonData);
            }
        }
        catch (HttpRequestException ex)
        {
            _logger.LogError($"HTTP request error: {ex.Message}");
            return StatusCode(500, new { error = "Network error while fetching data" });
        }
        catch (TaskCanceledException ex)
        {
            _logger.LogError($"Request timeout: {ex.Message}");
            return StatusCode(408, new { error = "Request timeout" });
        }
        catch (Exception ex)
        {
            _logger.LogError($"Unexpected error: {ex.Message}");
            return StatusCode(500, new { error = "Internal server error" });
        }
    }
}
