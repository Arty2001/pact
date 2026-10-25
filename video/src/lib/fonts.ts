/**
 * Fonts, loaded through Remotion so the renderer waits for them.
 *
 * Without this the first frames render in a fallback face and the cut opens
 * with a visible reflow - a defect that only shows up in the final file and
 * never in the studio, because the studio has them cached.
 *
 * Weights and subsets are pinned to exactly what the film uses. Left
 * unrestricted, these three families pulled 126 network requests per render
 * worker: every weight, every subset, almost all of it discarded. The film
 * uses four weights of Inter, two of the mono and three of the display, and
 * nothing outside latin.
 */

import { loadFont as inter } from "@remotion/google-fonts/Inter";
import { loadFont as mono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as hanken } from "@remotion/google-fonts/HankenGrotesk";

export const loadFonts = () => {
  // loadFont(style, options) - the style comes first. Passing the options
  // object as the first argument typechecks as a bad style key and then
  // throws at module load, which surfaces as a webpack trace pointing at
  // whatever imported it rather than at this file.
  inter("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
  mono("normal", { weights: ["400", "700"], subsets: ["latin"] });
  hanken("normal", { weights: ["500", "600", "700"], subsets: ["latin"] });
};
