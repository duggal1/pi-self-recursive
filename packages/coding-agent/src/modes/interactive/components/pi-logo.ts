import { foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const PURPLE = rgbColor(99, 102, 241);
const RESET = "\x1b[0m";

/**
 * The pi logo: a full-block pixel glyph, 10 cells wide and 4 rows tall, so it
 * reads as chunky pixel art and renders identically on every terminal
 * (half-block art misaligns on some, e.g. Apple Terminal).
 *
 *   ██████████
 *   ███    ███
 *   ██████████
 *   ███    ███
 *
 * The brand color stays fixed across themes; it follows the terminal's color mode.
 */
const PIXEL_ROWS = [0b1111111111, 0b1110000111, 0b1111111111, 0b1110000111];
export const PI_LOGO_WIDTH = 10;

export function piLogoLines(): string[] {
	const mode = theme.getColorMode();
	const fg = (color: typeof PURPLE) => foregroundAnsi(color, mode);
	return PIXEL_ROWS.map((row) => {
		let line = "";
		for (let col = 0; col < PI_LOGO_WIDTH; col++) {
			line += (row >> (PI_LOGO_WIDTH - 1 - col)) & 1 ? `${fg(PURPLE)}█${RESET}` : " ";
		}
		return line;
	});
}

/**
 * Whether the terminal renders the logo correctly. The glyph is full-block
 * only, so it renders identically everywhere.
 */
export function supportsPiLogo(): boolean {
	return true;
}

/** Text fallback for the logo: "Pi" in the brand purple. */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(PURPLE, mode)}P${RESET}${foregroundAnsi(PURPLE, mode)}i${RESET}`;
}
