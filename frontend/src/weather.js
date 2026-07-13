// Weather-aware suggestions (open-meteo — free, no API key). Reads current
// conditions near the start point and proposes a route setup, tying the hot+sunny
// case straight into the shade engine.

export async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,wind_speed_10m,is_day,precipitation` +
    `&hourly=precipitation_probability&forecast_hours=3&timezone=auto`;
  const d = await fetch(url).then((r) => r.json());
  if (!d.current) throw new Error("sem dados de tempo");
  return d;
}

function interpret(d) {
  const c = d.current;
  const temp = Math.round(c.apparent_temperature ?? c.temperature_2m);
  const localHour = parseInt(String(c.time).slice(11, 13), 10); // timezone=auto → local
  const rainSoon = Math.max(0, ...(d.hourly?.precipitation_probability?.slice(0, 3) ?? [0]));
  return {
    temp,
    localHour,
    rainSoon,
    isDay: !!c.is_day,
    sunny: c.cloud_cover < 40,
    cloud: c.cloud_cover,
    wind: c.wind_speed_10m,
  };
}

// Turn conditions into a suggestion the user can apply with one tap.
// { icon, headline, message, pref, hour?, distanceKm? }
export function suggest(d) {
  const w = interpret(d);

  if (w.rainSoon >= 50) {
    return {
      icon: "🌧️",
      headline: `${w.temp}° · chuva provável (${w.rainSoon}%)`,
      message: "Chuva a caminho — sugeri um loop mais curto pra você não se molhar.",
      pref: "none",
      distanceKm: 3,
    };
  }
  if (w.isDay && w.temp >= 28 && w.sunny) {
    return {
      icon: "☀️",
      headline: `${w.temp}° · sol forte`,
      message: "Está quente e ensolarado — priorizei sombra pra sua caminhada mais fresca.",
      pref: "shade",
      hour: Math.max(6, Math.min(18, w.localHour)),
    };
  }
  if (w.isDay && w.temp >= 15 && w.rainSoon < 30) {
    return {
      icon: w.sunny ? "🌤️" : "⛅",
      headline: `${w.temp}° · tempo bom`,
      message: "Dia agradável pra caminhar — que tal aproveitar o verde?",
      pref: "green",
    };
  }
  if (!w.isDay) {
    return {
      icon: "🌙",
      headline: `${w.temp}° · noite`,
      message: "Caminhada noturna — prefira ruas conhecidas e bem movimentadas.",
      pref: "none",
    };
  }
  return {
    icon: "🌥️",
    headline: `${w.temp}°${w.wind >= 30 ? " · ventando" : ""}`,
    message: "Bom momento pra uma caminhada tranquila.",
    pref: "none",
  };
}
