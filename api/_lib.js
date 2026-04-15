// Shared helpers for the API routes.
// Runs on Vercel's Node.js runtime.

import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Two-stage pipeline uses two different models on purpose:
// - Research: Sonnet + web_search. Commits to a small set of tone descriptors.
// - Generate: Haiku. Once the voice is committed, Haiku executes voice-in-a-box
//   extremely well and cheaply. Sonnet on the generate step over-reasons about
//   constraints and smooths everything toward the same polite rhythm.
export const MODEL = "claude-sonnet-4-6";            // legacy alias — research default
export const MODEL_RESEARCH = "claude-sonnet-4-6";
export const MODEL_GENERATE = "claude-haiku-4-5-20251001";

// Very simple shared-password gate.
// The frontend sends the password in an `x-app-password` header.
// If it doesn't match SHARED_PASSWORD env var, the request is rejected.
export function checkPassword(req) {
  const expected = process.env.SHARED_PASSWORD;
  if (!expected) return { ok: true }; // no password set — open access
  const provided = req.headers["x-app-password"];
  if (!provided || provided !== expected) {
    return { ok: false, status: 401, error: "Unauthorized. Check your password." };
  }
  return { ok: true };
}

// Extract text from Claude's response (ignoring tool-use blocks).
export function extractText(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Helper: try to pull the first JSON object out of a string.
// Claude occasionally wraps JSON in prose or code fences; this is resilient.
export function parseJsonLoose(text) {
  if (!text) throw new Error("Empty response from model.");
  // Strip markdown code fences if present.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Find the last closing brace to avoid greedily swallowing trailing prose.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Could not parse JSON from model response.");
  }
}

// Small safety clamp on user input lengths.
export function clamp(str, max = 500) {
  if (typeof str !== "string") return "";
  return str.slice(0, max);
}
