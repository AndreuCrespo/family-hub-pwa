// Open-Meteo forecast and geocoding (free, no API key).
import { useApp } from '../../core/app';
import { useRemote } from '../../core/remote';
import { getLang, t } from '../../i18n';

export interface Weather {
  current: { temp: number; code: number; wind: number; humidity: number; isDay: boolean };
  hourly: { time: string[]; temp: number[]; code: number[]; pop: number[]; isDay: number[] };
  daily: {
    date: string[];
    code: number[];
    max: number[];
    min: number[];
    pop: number[];
    rain: number[];
    wind: number[];
    sunrise: string[];
    sunset: string[];
  };
}

/** Forecast for one day. */
export interface DayWeather {
  code: number;
  max: number;
  min: number;
  pop: number;
  sunrise: string;
  sunset: string;
}

interface ForecastResponse {
  current: {
    temperature_2m: number;
    weather_code: number;
    wind_speed_10m: number;
    relative_humidity_2m: number;
    is_day: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    weather_code: number[];
    precipitation_probability: (number | null)[];
    is_day: number[];
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    precipitation_sum: number[];
    wind_speed_10m_max: number[];
    sunrise: string[];
    sunset: string[];
  };
}

const nums = (list: (number | null)[]) => list.map((v) => v ?? 0);

async function fetchWeather(lat: number, lon: number, tz: string): Promise<Weather> {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: tz,
    forecast_days: '8',
    current: 'temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset',
  });
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = (await r.json()) as ForecastResponse;
  return {
    current: {
      temp: j.current.temperature_2m,
      code: j.current.weather_code,
      wind: j.current.wind_speed_10m,
      humidity: j.current.relative_humidity_2m,
      isDay: j.current.is_day === 1,
    },
    hourly: {
      time: j.hourly.time,
      temp: j.hourly.temperature_2m,
      code: j.hourly.weather_code,
      pop: nums(j.hourly.precipitation_probability),
      isDay: j.hourly.is_day,
    },
    daily: {
      date: j.daily.time,
      code: j.daily.weather_code,
      max: j.daily.temperature_2m_max,
      min: j.daily.temperature_2m_min,
      pop: nums(j.daily.precipitation_probability_max),
      rain: j.daily.precipitation_sum,
      wind: j.daily.wind_speed_10m_max,
      sunrise: j.daily.sunrise,
      sunset: j.daily.sunset,
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A stored copy of the forecast in the current format. */
export function isWeather(v: unknown): v is Weather {
  if (!isRecord(v) || !isRecord(v.current) || !isRecord(v.hourly) || !isRecord(v.daily)) return false;
  const { current, hourly, daily } = v;
  return (
    typeof current.temp === 'number' &&
    typeof current.code === 'number' &&
    ['time', 'temp', 'code', 'pop', 'isDay'].every((k) => Array.isArray(hourly[k])) &&
    ['date', 'code', 'max', 'min', 'pop', 'sunrise', 'sunset'].every((k) => Array.isArray(daily[k]))
  );
}

/** Forecast for the household's location (refreshed every 30 minutes). */
export function useWeather() {
  const { household, tz } = useApp();
  const loc = household.location;
  const key = loc ? `weather:${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}` : null;
  return useRemote(
    key,
    () => (loc ? fetchWeather(loc.lat, loc.lon, tz) : Promise.reject(new Error('No location'))),
    30 * 60_000,
    isWeather,
  );
}

/** The forecast of one day (undefined if it's outside the forecast). */
export function dayWeather(w: Weather | undefined, date: string): DayWeather | undefined {
  const i = w ? w.daily.date.indexOf(date) : -1;
  if (!w || i < 0) return undefined;
  const d = w.daily;
  return {
    code: d.code[i] ?? 0,
    max: d.max[i] ?? 0,
    min: d.min[i] ?? 0,
    pop: d.pop[i] ?? 0,
    sunrise: d.sunrise[i] ?? '',
    sunset: d.sunset[i] ?? '',
  };
}

export interface GeoResult {
  name: string;
  admin1?: string;
  country?: string;
  lat: number;
  lon: number;
}

interface GeoResponse {
  results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[];
}

export async function searchPlaces(name: string): Promise<GeoResult[]> {
  const q = new URLSearchParams({ name, count: '6', language: getLang(), format: 'json' });
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${q}`);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = (await r.json()) as GeoResponse;
  return (j.results ?? []).map((x) => ({
    name: x.name,
    admin1: x.admin1,
    country: x.country,
    lat: x.latitude,
    lon: x.longitude,
  }));
}

/** Human description of a WMO weather code. */
export function weatherLabel(code: number): string {
  if (code === 0) return t('wx.clear');
  if (code === 1) return t('wx.mostlyClear');
  if (code === 2) return t('wx.partlyCloudy');
  if (code === 3) return t('wx.cloudy');
  if (code === 45 || code === 48) return t('wx.fog');
  if (code >= 51 && code <= 57) return t('wx.drizzle');
  if (code >= 61 && code <= 67) return t('wx.rain');
  if (code >= 71 && code <= 77) return t('wx.snow');
  if (code >= 80 && code <= 82) return t('wx.showers');
  if (code === 85 || code === 86) return t('wx.snowShowers');
  if (code >= 95) return t('wx.storm');
  return '—';
}

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

export function weatherKind(code: number): WeatherKind {
  if (code <= 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'storm';
}
