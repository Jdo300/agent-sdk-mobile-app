import { memo, useMemo, type ReactNode } from "react";
import { Text as RNText, Platform, type TextStyle } from "react-native";

import { useTheme } from "../../theme/ThemeProvider";
import { monoFamily } from "../../theme/tokens";

const languageKeywords: Record<string, Set<string>> = {
  javascript: new Set("async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined".split(" ")),
  typescript: new Set("abstract any as asserts async await boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield".split(" ")),
  python: new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" ")),
  java: new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null".split(" ")),
  c: new Set("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while".split(" ")),
  cpp: new Set("alignas alignof and asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while".split(" ")),
  bash: new Set("case do done elif else esac fi for function if in select then time until while".split(" ")),
  sql: new Set("select from where join inner left right full on group by order having insert into update delete create alter drop table index view distinct union all as and or not null is like in exists between case when then else end limit offset".split(" ")),
};

const aliases: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  cxx: "cpp",
};

interface HighlightPart { text: string; type?: "comment" | "string" | "number" | "keyword" | "function" | "boolean"; }

const tokenPattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g;

function highlight(code: string, language: string | null): HighlightPart[] {
  const normalized = language ? aliases[language.toLowerCase()] ?? language.toLowerCase() : "";
  const keywords = languageKeywords[normalized] ?? new Set<string>();
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const match of code.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: code.slice(cursor, index) });
    const text = match[0];
    let type: HighlightPart["type"];
    if (text.startsWith("//") || text.startsWith("/*") || text.startsWith("#")) type = "comment";
    else if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) type = "string";
    else if (/^\d/.test(text)) type = "number";
    else if (["true", "false", "True", "False", "null", "None"].includes(text)) type = "boolean";
    else if (keywords.has(text) || keywords.has(text.toLowerCase())) type = "keyword";
    else if (/^\s*\(/.test(code.slice(index + text.length))) type = "function";
    parts.push({ text, type });
    cursor = index + text.length;
  }
  if (cursor < code.length) parts.push({ text: code.slice(cursor) });
  return parts;
}

function partColor(type: HighlightPart["type"], dark: boolean): string | undefined {
  if (!type) return undefined;
  const colors = dark
    ? { comment: "#7F8C98", string: "#C3E88D", number: "#F78C6C", keyword: "#C792EA", function: "#82AAFF", boolean: "#F78C6C" }
    : { comment: "#6A737D", string: "#22863A", number: "#B31D28", keyword: "#7C3AED", function: "#005CC5", boolean: "#B31D28" };
  return colors[type];
}

export const SyntaxCode = memo(function SyntaxCode({
  code,
  language,
  selectable = false,
  style,
}: {
  code: string;
  language: string | null;
  selectable?: boolean;
  style?: TextStyle;
}) {
  const { colors, name } = useTheme();
  const parts = useMemo(() => highlight(code, language), [code, language]);
  const dark = name === "dark";
  const children: ReactNode[] = parts.map((part, index) => (
    <RNText key={index} style={{ color: partColor(part.type, dark) }}>{part.text}</RNText>
  ));

  return (
    <RNText
      selectable={selectable}
      style={[
        { color: colors.ink, fontFamily: Platform.select(monoFamily), fontSize: 13, lineHeight: 18 },
        style,
      ]}
    >
      {children}
    </RNText>
  );
});
