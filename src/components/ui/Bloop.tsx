/**
 * Agent avatar: a glossy sphere ("bloop") whose color is picked
 * deterministically from the agent id, so an agent always looks the same
 * (docs/design-doc.md §2.6). No initials — a name can be long, non-Latin, or
 * absent, and a shape reads faster in a list than two letters do.
 *
 * The specular highlight is what makes it read as an object rather than a dot;
 * its angle varies per agent so a list of bloops has some life in it.
 */
import { View } from "react-native";
import Svg, { Circle, Ellipse, G } from "react-native-svg";

import { bloopColors } from "../../theme/tokens";

/**
 * FNV-1a. The obvious `h * 31 + c` collides badly on the short, similar strings
 * agents actually get named — "Docs rewrite", "Nightly triage" and "Schema
 * migration" all landed on one color, which makes a list look broken.
 */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Twelve hues is still fewer than the agents a busy account has, so a second
 * slice of the hash nudges lightness. Two agents that land on the same hue stay
 * distinguishable instead of reading as one color.
 */
export function bloopColor(id: string): string {
  const h = hash(id);
  const base = bloopColors[h % bloopColors.length]!;
  const shift = (((h >> 5) % 5) - 2) * 0.045;
  return shiftLightness(base, shift);
}

function shiftLightness(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (offset: number) => {
    const value = (n >> offset) & 0xff;
    const next = amount >= 0 ? value + (255 - value) * amount : value * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  return `#${[channel(16), channel(8), channel(0)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function Bloop({ id, size = 40, color }: { id: string; size?: number; color?: string }) {
  const h = hash(id);
  const fill = color ?? bloopColor(id);
  // A little asymmetry per agent: the sphere is never perfectly round, and the
  // highlight sits at a slightly different angle each time.
  const squash = 1 - ((h >> 3) % 5) / 100;
  const tilt = -30 - ((h >> 7) % 30);
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Ellipse cx="50" cy="50" rx="50" ry={50 * squash} fill={fill} />
        <G transform={`rotate(${tilt} 68 30)`}>
          {/* crescent gloss: a white sliver masked by the sphere's own color */}
          <Ellipse cx="70" cy="28" rx="11" ry="18" fill="#FFFFFF" opacity={0.95} />
          <Ellipse cx="65" cy="31" rx="11" ry="18" fill={fill} />
        </G>
        <Circle cx="50" cy="50" r="49.5" fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="1" />
      </Svg>
    </View>
  );
}
