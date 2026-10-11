// Shared by the fake-jev fixture and the global test guard: is this request
// headed for a typesafe.ai host? Parsed, lowercased, trailing dot stripped; an
// unparseable URL is treated as typesafe if it even mentions the host.
export const urlOf = (input) => (input instanceof Request ? input.url : String(input));
export const isTypesafe = (url) => {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return /typesafe\.ai/i.test(url);
  }
  return host === "typesafe.ai" || host.endsWith(".typesafe.ai");
};
