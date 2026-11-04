/** Normalise song/artist names for fuzzy comparison. */
const VERSION_NOISE =
  /\s[-–]\s.*\b(remaster(ed)?|mono|stereo|version|edit|mix|live|deluxe|anniversary|single)\b.*$|\s*[([][^)\]]*\b(remaster(ed)?|mono|stereo|version|feat\.?|ft\.?|with|edit|deluxe|anniversary)\b[^)\]]*[)\]]/gi

export const normalize = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(VERSION_NOISE, "")
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
