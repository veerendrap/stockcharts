using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using StockChartsMvc.Models;

namespace StockChartsMvc.Controllers;

public class HomeController : Controller
{
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
