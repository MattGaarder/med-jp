# Formatting Romaji Input for Best Translation

This medical interpreter uses a two-stage translation pipeline: 
1. **Preprocessor:** A targeted fuzzy-matching system that catches severe medical misspellings (e.g. `zutsu` → `zutsuu`) before they reach the AI.
2. **Translation Engine:** A literal LLM translator that handles the complex Japanese conversational grammar and context.

Because the system is aggressively hunting for medical terminology, heavily misspelled conversational grammar can sometimes be mistaken for a medical term if it isn't typed clearly. Following these rules ensures the highest accuracy possible.

## 1. Separate Particles from Verbs/Nouns
Try to type particles (`ga`, `wa`, `ni`, `o`) separately from the preceding noun, and suffixes separately from verbs where possible. The preprocessor analyzes *tokens* (words separated by spaces).
- ❌ **Bad:** `atamagaitai`
- ✅ **Good:** `atama ga itai`

- ❌ **Bad:** `kazehiitemasu`
- ✅ **Good:** `kaze hiite imasu`

## 2. Don't Smash Agglutinative Verb Endings
Japanese verbs can stack endlessly (`tabetaku nai`). If you smash them all into one massive romaji string without standard vowels, it can trip the fuzzy matcher into thinking you misspelled a disease.
- ❌ **Bad:** `omoimashit`, `ikitakutnai` 
- ✅ **Good:** `omoimashita`, `ikitaku nai`

## 3. Spell "R"s and "L"s properly
While the system is robust, Japanese romaji exclusively uses "r" sounds, not "l". Using "l" instead of "r" forces the fuzzy-matcher to guess what you meant.
- ❌ **Bad:** `alelugi`, `kulusii`
- ✅ **Good:** `arerugi`, `kurushii`

## 4. Use Punctuation Clauses
A 40-word run-on romaji sentence is mathematically very difficult for language models to parse efficiently. Break clauses up using full stops (`.`) or commas (`,`).
- ❌ **Bad:** `netsu mo atte memai mo surun desu kedo ashita no shigoto mo aru shi kusuri dake de kikareru ka fuan de...`
- ✅ **Good:** `netsu mo atte memai mo surun desu kedo. ashita no shigoto mo aru shi. kusuri dake de kikareru ka fuan de.`

## 5. Trust the AI for Slang and Context
You don't need to try and manually formalize spoken medical slang (like "gaze" for gauze or "chotto..." for pain). The LLM is highly familiar with Japanese medical slang, so as long as you spell it phonetically correctly (using Hepburn romaji), the engine will interpret the literal intent perfectly!
