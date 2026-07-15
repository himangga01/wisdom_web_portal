export type RevealDirection = "left" | "right" | "fade";

export interface HomeRevealTarget {
  key: string;
  direction: RevealDirection;
  delayMs: 0 | 60 | 120;
}

export const HOME_REVEAL_TARGETS = [
  { key: "hero-copy", direction: "left", delayMs: 0 },
  { key: "portrait", direction: "right", delayMs: 0 },
  { key: "practice-enterprise", direction: "left", delayMs: 0 },
  { key: "practice-procurement", direction: "right", delayMs: 60 },
  { key: "practice-visa", direction: "left", delayMs: 120 },
  { key: "navigator-copy", direction: "left", delayMs: 0 },
  { key: "navigator-choices", direction: "right", delayMs: 0 },
  { key: "principles-heading", direction: "fade", delayMs: 0 },
  { key: "principle-direct", direction: "right", delayMs: 0 },
  { key: "principle-alternative", direction: "left", delayMs: 60 },
  { key: "principle-field", direction: "right", delayMs: 120 },
  { key: "insights-heading", direction: "fade", delayMs: 0 },
  { key: "insight-procurement", direction: "left", delayMs: 0 },
  { key: "insight-enterprise", direction: "right", delayMs: 60 },
  { key: "insight-visa", direction: "left", delayMs: 120 },
  { key: "credentials", direction: "right", delayMs: 0 },
  { key: "consultation-copy", direction: "left", delayMs: 0 },
  { key: "consultation-card", direction: "right", delayMs: 0 },
] as const satisfies readonly HomeRevealTarget[];
