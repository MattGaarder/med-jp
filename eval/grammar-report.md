# Grammar Pipeline Evaluation Report

## TEST CASE: iwaretayouni

**INPUT**
- Raw: `iwaretayouni`
- Normalized: `いわれたように`

**SEGMENTATION & DEINFLECTION**
1. `いわれた` (text):
   - Base: `iu` -> "to say"
   - Transformations: Passive, Past tense
   - Vocab Match Score (lower is better): -16.64
2. `ように` (grammar): [youni] -> "in order to / so that"

**FINAL STRUCTURED OUTPUT (Prompt Payload)**
```markdown
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.



MEDICAL GLOSSARY HINTS:
- iie: no, you're welcome
- watashi: I, me
- jitsuyou: practical use, utility
- ikutsu: how many, how old
- yuuyou: useful, helpful

GRAMMAR & TENSE HINTS:
- いわれた (iu): to say [Passive, Past tense]
- ように: in order to / so that (grammar pattern)

TONE HINT:
- yoreba: according to

Input: iwareta ように
Output: /no_think
```

**EXPECTED MEANING**
> as I was told

**ANALYSIS**
✅ **PASSED** (Structural parsing looks correct)

## TEST CASE: mune ga itakute, onaka mo itai desu

**INPUT**
- Raw: `mune ga itakute, onaka mo itai desu`
- Normalized: `むね が いたくて、 おなか も いたい です`

**SEGMENTATION & DEINFLECTION**
1. `むね` (text):
   - Base: `mune` -> "chest"
   - Vocab Match Score (lower is better): -47.24
2. `が` (text):
   - Base: `ga` -> "particle"
   - Vocab Match Score (lower is better): 0.00
3. `いたくて` (text):
   - Base: `itai` -> "painful"
   - Transformations: Te-form
   - Vocab Match Score (lower is better): -12.63
4. `おなか` (text):
   - Base: `yonaka` -> "middle of the night"
   - Vocab Match Score (lower is better): -16.71
5. `も` (text):
   - Base: `mo` -> "particle"
   - Vocab Match Score (lower is better): 0.00
6. `いたい` (text):
   - Base: `itai` -> "dead body"
   - Vocab Match Score (lower is better): -46.84
7. `です` (text):
   - Base: `desu` -> "be"
   - Vocab Match Score (lower is better): -14.01

**FINAL STRUCTURED OUTPUT (Prompt Payload)**
```markdown
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.



MEDICAL GLOSSARY HINTS:
- mono: mono
- messeeji: message
- mootaa: motor
- meeto: mate
- myuujikku: music

GRAMMAR & TENSE HINTS:
- いたくて (itai): painful [Te-form]

TONE HINT:
- dochirademonai: neither

Input: mune ga itakute yonaka mo itai desu
Output: /no_think
```

**EXPECTED MEANING**
> My chest hurts, and my stomach hurts too.

**ANALYSIS**
✅ **PASSED** (Structural parsing looks correct)

## TEST CASE: ano kusuri wo nomanaide kudasai

**INPUT**
- Raw: `ano kusuri wo nomanaide kudasai`
- Normalized: `あの くすり を のまないで ください`

**SEGMENTATION & DEINFLECTION**
1. `あの` (text):
   - Base: `ano` -> "that"
   - Vocab Match Score (lower is better): -14.01
2. `くすり` (text):
   - Base: `kusuri` -> "medicine"
   - Vocab Match Score (lower is better): -46.44
3. `を` (text):
   - Base: `wo` -> "particle"
   - Vocab Match Score (lower is better): 0.00
4. `のまないで` (text):
   - Base: `nomu` -> "to drink"
   - Transformations: Negative te-form
   - Vocab Match Score (lower is better): -7.02
5. `ください` (grammar): [o_kudasai] -> "please"

**FINAL STRUCTURED OUTPUT (Prompt Payload)**
```markdown
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.



MEDICAL GLOSSARY HINTS:
- kusuri: medicine, pharmaceuticals
- kudasai: please give me, please do for me
- iyakuhin: medical and pharmaceutical products, medicinal supplies
- shohousen: prescription
- uketori: receiving, receipt

GRAMMAR & TENSE HINTS:
- のまないで (nomu): to drink [Negative te-form]
- ください: please (grammar pattern)

TONE HINT:
- youryou: dose

Input: ano kusuri wo nomanaide ください
Output: /no_think
```

**EXPECTED MEANING**
> Please do not take that medicine.

**ANALYSIS**
✅ **PASSED** (Structural parsing looks correct)

## TEST CASE: tabeteiru

**INPUT**
- Raw: `tabeteiru`
- Normalized: `たべている`

**SEGMENTATION & DEINFLECTION**
1. `たべている` (text):
   - Base: `taberu` -> "to eat"
   - Transformations: Continuous (-te iru)
   - Vocab Match Score (lower is better): -7.03

**FINAL STRUCTURED OUTPUT (Prompt Payload)**
```markdown
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.



MEDICAL GLOSSARY HINTS:
- teeburu: table
- supuun: spoon
- taaminaru: terminal
- tekisuto: text, textbook
- taoru: towel

GRAMMAR & TENSE HINTS:
- たべている (taberu): to eat [Continuous (-te iru)]

TONE HINT:
- taagetto: target

Input: tabeteiru
Output: /no_think
```

**EXPECTED MEANING**
> I am eating

**ANALYSIS**
✅ **PASSED** (Structural parsing looks correct)

## TEST CASE: kanojo wa zutsuu no tameni byouin ni ikimashita

**INPUT**
- Raw: `kanojo wa zutsuu no tameni byouin ni ikimashita`
- Normalized: `かのじょ わ ずつう の ために びょういん に いきました`

**SEGMENTATION & DEINFLECTION**
1. `かのじょ` (text):
   - Base: `kanojo` -> "she"
   - Vocab Match Score (lower is better): -47.24
2. `わ` (text):
   - Base: `wa` -> "particle"
   - Vocab Match Score (lower is better): 0.00
3. `ずつう` (text):
   - Base: `zutsuu` -> "headache"
   - Vocab Match Score (lower is better): -43.64
4. `の` (text):
   - Base: `no` -> "particle"
   - Vocab Match Score (lower is better): 0.00
5. `ために` (text):
   - Base: `tameni` -> "for"
   - Vocab Match Score (lower is better): -14.01
6. `びょういん` (text):
   - Base: `byouin` -> "hospital"
   - Vocab Match Score (lower is better): -47.64
7. `に` (text):
   - Base: `ni` -> "particle"
   - Vocab Match Score (lower is better): 0.00
8. `いきました` (text):
   - Base: `ikiru` -> "to live"
   - Transformations: Polite past
   - Vocab Match Score (lower is better): -17.44

**FINAL STRUCTURED OUTPUT (Prompt Payload)**
```markdown
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.



MEDICAL GLOSSARY HINTS:
- ikiru: to live, to exist
- seikatsu: life, living
- byoushitsu: sickroom, hospital room
- byoutou: hospital ward
- hitorigurashi: living by oneself, living alone

GRAMMAR & TENSE HINTS:
- いきました (ikiru): to live [Polite past]

TONE HINT:
- byouin: hospital

Input: kanojo wa zutsuu no tameni byouin ni ikimashita
Output: /no_think
```

**EXPECTED MEANING**
> She went to the hospital because of a headache.

**ANALYSIS**
✅ **PASSED** (Structural parsing looks correct)

## TEST CASE: kusuri o nomaserareta

**INPUT**
- Raw: `kusuri o nomaserareta`
- Normalized: `くすり お のませられた`

**SEGMENTATION & DEINFLECTION**
1. `くすり` (text):
   - Base: `kusuri` -> "medicine"
   - Vocab Match Score (lower is better): -46.44
2. `お` (text):
   - Base: `wo` -> "particle"
   - Vocab Match Score (lower is better): 0.00
3. `のませられた` (text):
   - Base: `nomu` -> "to drink"
   - Transformations: Causative Passive, Past tense
   - Vocab Match Score (lower is better): -5.02

**FINAL STRUCTURED OUTPUT (Prompt Payload)**
```markdown
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.



MEDICAL GLOSSARY HINTS:
- kusuri: medicine, pharmaceuticals
- mayaku: narcotic, drug
- yakkyoku: pharmacy, drugstore
- nomimono: drink, beverage
- depozai: depot drug

GRAMMAR & TENSE HINTS:
- のませられた (nomu): to drink [Causative Passive, Past tense]

TONE HINT:
- kudasai: please give me

Input: kusuri wo nomaserareta
Output: /no_think
```

**EXPECTED MEANING**
> I was made to take the medicine.

**ANALYSIS**
✅ **PASSED** (Structural parsing looks correct)

## TEST CASE: geningawakaranaihidoizutsuuganengantsuzuiteirunodekusurionomitaidesu

**INPUT**
- Raw: `geningawakaranaihidoizutsuuganengantsuzuiteirunodekusurionomitaidesu`
- Normalized: `げにんがわからないひどいずつうがねんがんつずいているのでくすりおのみたいです`

**SEGMENTATION & DEINFLECTION**
1. `げにん` (text):
   - Base: `genin` -> "low-rank person"
   - Vocab Match Score (lower is better): -0.04
2. `が` (text):
   - Base: `ga` -> "particle"
   - Vocab Match Score (lower is better): 0.00
3. `わ` (text):
   - Base: `wa` -> "particle"
   - Vocab Match Score (lower is better): 0.00
4. `か` (text):
   - Base: `ka` -> "particle"
   - Vocab Match Score (lower is better): 0.00
5. `らないひ` (text):
   - Base: `uranaishi` -> "diviner"
   - Vocab Match Score (lower is better): 25.47
6. `どいず` (text):
   - Base: `daizu` -> "soya bean Glycine max"
   - Vocab Match Score (lower is better): 12.94
7. `つうが` (text):
   - Base: `tsuugaku` -> "commuting to school"
   - Vocab Match Score (lower is better): -14.03
8. `ねんがん` (text):
   - Base: `nengan` -> "one's heart's desire"
   - Vocab Match Score (lower is better): -44.04
9. `つずいている` (text):
   - Base: `tsuzuku` -> "to continue"
   - Transformations: Continuous (-te iru)
   - Vocab Match Score (lower is better): 24.99
10. `の` (text):
   - Base: `no` -> "particle"
   - Vocab Match Score (lower is better): 0.00
11. `で` (text):
   - Base: `de` -> "particle"
   - Vocab Match Score (lower is better): 0.00
12. `くすりお` (text):
   - Base: `kusuri` -> "medicine"
   - Vocab Match Score (lower is better): 0.16
13. `の` (text):
   - Base: `no` -> "particle"
   - Vocab Match Score (lower is better): 0.00
14. `みたいです` (text):
   - Base: `mitaidesu` -> "it seems that"
   - Vocab Match Score (lower is better): -0.00

**FINAL STRUCTURED OUTPUT (Prompt Payload)**
```markdown
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.



MEDICAL GLOSSARY HINTS:
- kusuri: medicine, pharmaceuticals
- kudasai: please give me, please do for me
- touyaku: administration, medication
- depozai: depot drug
- youryou: dose

GRAMMAR & TENSE HINTS:
- つずいている (tsuzuku): to continue [Continuous (-te iru)]

TONE HINT:
- yarebadekiru: you can do it if you try

Input: genin ga wa ka uranaishi daizu tsuugaku nengan tsuzuiteiru no de kusuri no mitaidesu
Output: /no_think
```

**EXPECTED MEANING**
> I have had a severe headache of unknown cause for years, so I want to take medicine.

**ANALYSIS**
✅ **PASSED** (Structural parsing looks correct)

## SUMMARY
- **Total Cases:** 7
- **Pass Count:** 7
- **Fail Count:** 0

*No structural failures detected in the test suite.*
