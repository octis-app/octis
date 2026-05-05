import React from 'react'

/**
 * DecisionButtons — renders A / B / C clickable buttons below any assistant
 * message that contains the Options Pattern (lines starting with A), B), C)
 * optionally wrapped in markdown bold: **A)**).
 *
 * Usage:
 *   <DecisionButtons text={extractedText} onSelect={(letter) => sendChat(letter)} />
 *
 * Returns null when the text does not contain an options pattern.
 */

const OPTION_RE = /^\s*\*{0,2}([A-D])\){1}\*{0,2}/m

/** Returns the letters found in the message (A, B, C, D) or empty array. */
export function detectDecisionOptions(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  const letters: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^\s*\*{0,2}([A-D])\)\*{0,2}/)
    if (m) {
      const letter = m[1].toUpperCase()
      if (!seen.has(letter)) {
        seen.add(letter)
        letters.push(letter)
      }
    }
  }
  // Need at least 2 options to qualify (A alone isn't a decision pattern)
  return letters.length >= 2 ? letters : []
}

interface DecisionButtonsProps {
  text: string
  onSelect: (letter: string) => void
}

export default function DecisionButtons({ text, onSelect }: DecisionButtonsProps) {
  const options = detectDecisionOptions(text)
  if (options.length === 0) return null

  return (
    <div className="flex gap-1.5 mt-2 flex-wrap">
      {options.map((letter) => (
        <button
          key={letter}
          onClick={() => onSelect(letter)}
          className="
            px-3 py-1 rounded-lg text-xs font-semibold
            bg-[#6366f1]/20 text-[#a5b4fc]
            border border-[#6366f1]/40
            hover:bg-[#6366f1]/40 hover:text-white hover:border-[#6366f1]
            active:scale-95
            transition-all duration-100
            select-none cursor-pointer
          "
          title={`Choose option ${letter}`}
        >
          {letter}
        </button>
      ))}
    </div>
  )
}
