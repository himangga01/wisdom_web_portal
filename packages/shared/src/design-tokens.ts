export const designTokens = {
  color: {
    bronze: "#a78d6c",
    bronzeText: "#745b3f",
    sand: "#d8cabb",
    ivory: "#fffdfa",
    brown: "#5d4936",
    ink: "#2f2a25",
    white: "#ffffff",
  },
  font: {
    sans: '"Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", system-ui, sans-serif',
    serif: '"Iropke Batang", "Noto Serif KR", "Nanum Myeongjo", Georgia, serif',
  },
  motion: {
    homepageReveal: {
      targetCount: 18,
      durationMs: 500,
      distancePx: 64,
      staggerMs: 60,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  },
} as const;

export type DesignTokens = typeof designTokens;
