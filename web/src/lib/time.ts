// Every time is shown on the site's clock, which for both cameras is Lagos.
export const TIME_ZONE = 'Africa/Lagos';

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { timeZone: TIME_ZONE, hour12: false });
}

export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString('en-GB', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' });
}

export function dateAndTime(at: number): string {
  return `${shortDate(at)}, ${clockTime(at)}`;
}

export function sentence(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
