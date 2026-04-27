import * as wanakana from 'wanakana';

/**
 * deinflect.js
 *
 * A robust rule-based Japanese deinflection engine.
 * Adapted from the user's provided logic.
 */

export const Reason = {
  PolitePastNegative: 0,
  PoliteNegative: 1,
  PoliteVolitional: 2,
  Chau: 3,
  Sugiru: 4,
  PolitePast: 5,
  Tara: 6,
  Tari: 7,
  Causative: 8,
  PotentialOrPassive: 9,
  Toku: 10,
  Sou: 11,
  Tai: 12,
  Polite: 13,
  Respectful: 14,
  Humble: 15,
  HumbleOrKansaiDialect: 16,
  Past: 17,
  Negative: 18,
  Passive: 19,
  Ba: 20,
  Volitional: 21,
  Potential: 22,
  EruUru: 23,
  CausativePassive: 24,
  Te: 25,
  Zu: 26,
  Imperative: 27,
  MasuStem: 28,
  Adv: 29,
  Noun: 30,
  ImperativeNegative: 31,
  Continuous: 32,
  Ki: 33,
  SuruNoun: 34,
  ZaruWoEnai: 35,
  NegativeTe: 36,
  Irregular: 37,
};

export const deinflectL10NKeys = {
  [Reason.Respectful]: 'deinflect_respectful',
  [Reason.Humble]: 'deinflect_humble',
  [Reason.HumbleOrKansaiDialect]: 'deinflect_humble_or_kansai_dialect',
  [Reason.PolitePastNegative]: 'deinflect_polite_past_negative',
  [Reason.PoliteNegative]: 'deinflect_polite_negative',
  [Reason.PoliteVolitional]: 'deinflect_polite_volitional',
  [Reason.Chau]: 'deinflect_chau',
  [Reason.Sugiru]: 'deinflect_sugiru',
  [Reason.PolitePast]: 'deinflect_polite_past',
  [Reason.Tara]: 'deinflect_tara',
  [Reason.Tari]: 'deinflect_tari',
  [Reason.Causative]: 'deinflect_causative',
  [Reason.PotentialOrPassive]: 'deinflect_potential_or_passive',
  [Reason.Sou]: 'deinflect_sou',
  [Reason.Toku]: 'deinflect_toku',
  [Reason.Tai]: 'deinflect_tai',
  [Reason.Polite]: 'deinflect_polite',
  [Reason.Past]: 'deinflect_past',
  [Reason.Negative]: 'deinflect_negative',
  [Reason.Passive]: 'deinflect_passive',
  [Reason.Ba]: 'deinflect_ba',
  [Reason.Volitional]: 'deinflect_volitional',
  [Reason.Potential]: 'deinflect_potential',
  [Reason.EruUru]: 'deinflect_eru_uru',
  [Reason.CausativePassive]: 'deinflect_causative_passive',
  [Reason.Te]: 'deinflect_te',
  [Reason.Zu]: 'deinflect_zu',
  [Reason.Imperative]: 'deinflect_imperative',
  [Reason.MasuStem]: 'deinflect_masu_stem',
  [Reason.Adv]: 'deinflect_adv',
  [Reason.Noun]: 'deinflect_noun',
  [Reason.ImperativeNegative]: 'deinflect_imperative_negative',
  [Reason.Continuous]: 'deinflect_continuous',
  [Reason.Ki]: 'deinflect_ki',
  [Reason.SuruNoun]: 'deinflect_suru_noun',
  [Reason.ZaruWoEnai]: 'deinflect_zaru_wo_enai',
  [Reason.NegativeTe]: 'deinflect_negative_te',
  [Reason.Irregular]: 'deinflect_irregular',
};

export const deinflectTags = {
  [Reason.PolitePastNegative]: 'Polite past negative',
  [Reason.PoliteNegative]: 'Polite negative',
  [Reason.PoliteVolitional]: 'Polite volitional',
  [Reason.Chau]: 'To do completely',
  [Reason.Sugiru]: 'To do too much',
  [Reason.PolitePast]: 'Polite past',
  [Reason.Tara]: 'If / After (tara)',
  [Reason.Tari]: 'Such things as (tari)',
  [Reason.Causative]: 'Causative',
  [Reason.PotentialOrPassive]: 'Potential / Passive',
  [Reason.Toku]: 'To do in advance',
  [Reason.Sou]: 'Seems like',
  [Reason.Tai]: 'Want to do',
  [Reason.Polite]: 'Polite/Formal form',
  [Reason.Respectful]: 'Respectful',
  [Reason.Humble]: 'Humble',
  [Reason.HumbleOrKansaiDialect]: 'Humble / Kansai dialect',
  [Reason.Past]: 'Past tense',
  [Reason.Negative]: 'Negative',
  [Reason.Passive]: 'Passive',
  [Reason.Ba]: 'If (ba)',
  [Reason.Volitional]: 'Volitional',
  [Reason.Potential]: 'Potential',
  [Reason.EruUru]: 'Can do',
  [Reason.CausativePassive]: 'Causative Passive',
  [Reason.Te]: 'Te-form',
  [Reason.Zu]: 'Without doing',
  [Reason.Imperative]: 'Imperative',
  [Reason.MasuStem]: 'Masu stem',
  [Reason.Adv]: 'Adverbial',
  [Reason.Noun]: 'Noun form',
  [Reason.ImperativeNegative]: 'Imperative negative',
  [Reason.Continuous]: 'Continuous (-te iru)',
  [Reason.Ki]: 'Ki',
  [Reason.SuruNoun]: 'Noun + Suru',
  [Reason.ZaruWoEnai]: 'Cannot help but',
  [Reason.NegativeTe]: 'Negative te-form',
  [Reason.Irregular]: 'Irregular',
};

export function interpretReasonChains(chains) {
  if (!chains || chains.length === 0) return [];
  const firstChain = chains[0]; 
  return firstChain.map(reasonId => deinflectTags[reasonId]).filter(Boolean);
}

export const WordType = {
  // Final word type
  IchidanVerb: 1 << 0, // i.e. ru-verbs
  GodanVerb: 1 << 1, // i.e. u-verbs
  IAdj: 1 << 2,
  KuruVerb: 1 << 3,
  SuruVerb: 1 << 4,
  SpecialSuruVerb: 1 << 5,
  NounVS: 1 << 6,
  All: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6),
  // Intermediate types
  Initial: 1 << 7, // original word before any deinflection (from-type only)
  TaTeStem: 1 << 8,
  DaDeStem: 1 << 9,
  MasuStem: 1 << 10,
  IrrealisStem: 1 << 11,
};

// prettier-ignore
const deinflectRuleData = [
  // -------------- 7 --------------
  ['ていらっしゃい', '', WordType.Initial, WordType.TaTeStem, [Reason.Respectful, Reason.Continuous, Reason.Imperative], 1.0],
  ['ていらっしゃる', '', WordType.GodanVerb, WordType.TaTeStem, [Reason.Respectful, Reason.Continuous], 1.0],
  ['でいらっしゃい', '', WordType.Initial, WordType.DaDeStem, [Reason.Respectful, Reason.Continuous, Reason.Imperative], 1.0],
  ['でいらっしゃる', '', WordType.GodanVerb, WordType.DaDeStem, [Reason.Respectful, Reason.Continuous], 1.0],
  // -------------- 6 --------------
  ['いらっしゃい', 'いらっしゃる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['いらっしゃい', 'いらっしゃる', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['くありません', 'い', WordType.Initial, WordType.IAdj, [Reason.PoliteNegative], 1.0],
  ['ざるをえない', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  ['ざるを得ない', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  ['ませんでした', '', WordType.Initial, WordType.MasuStem, [Reason.PolitePastNegative], 1.0],
  ['てらっしゃい', '', WordType.Initial, WordType.TaTeStem, [Reason.Respectful, Reason.Continuous, Reason.Imperative], 1.0],
  ['てらっしゃい', 'てらっしゃる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['てらっしゃる', '', WordType.GodanVerb, WordType.TaTeStem, [Reason.Respectful, Reason.Continuous], 1.0],
  ['でらっしゃい', '', WordType.Initial, WordType.DaDeStem, [Reason.Respectful, Reason.Continuous, Reason.Imperative], 1.0],
  ['でらっしゃい', 'でらっしゃる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['でらっしゃる', '', WordType.GodanVerb, WordType.DaDeStem, [Reason.Respectful, Reason.Continuous], 1.0],
  // -------------- 5 --------------
  ['おっしゃい', 'おっしゃる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['おっしゃい', 'おっしゃる', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['ざるえない', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  ['ざる得ない', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  ['ざるをえぬ', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  ['ざるを得ぬ', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  // -------------- 4 --------------
  ['かったら', 'い', WordType.Initial, WordType.IAdj, [Reason.Tara], 1.0],
  ['かったり', 'い', WordType.Initial, WordType.IAdj, [Reason.Tari], 1.0],
  ['ください', 'くださる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['ください', 'くださる', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['こさせる', 'くる', WordType.IchidanVerb, WordType.KuruVerb, [Reason.Causative], 1.0],
  ['こられる', 'くる', WordType.IchidanVerb, WordType.KuruVerb, [Reason.PotentialOrPassive], 1.0],
  ['さないで', 'する', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.NegativeTe], 1.0],
  ['ざるえぬ', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  ['ざる得ぬ', '', WordType.IAdj, WordType.IrrealisStem, [Reason.ZaruWoEnai], 1.0],
  ['しないで', 'する', WordType.Initial, WordType.SuruVerb, [Reason.NegativeTe], 1.0],
  ['しさせる', 'する', WordType.IchidanVerb, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Causative], 1.0],
  ['しられる', 'する', WordType.IchidanVerb, WordType.SpecialSuruVerb, [Reason.Irregular, WordType.PotentialOrPassive], 1.0],
  ['せさせる', 'する', WordType.IchidanVerb, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Causative], 1.0],
  ['せられる', 'する', WordType.IchidanVerb, WordType.SpecialSuruVerb, [Reason.Irregular, WordType.PotentialOrPassive], 1.0],
  ['ぜさせる', 'ずる', WordType.IchidanVerb, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Causative], 1.0],
  ['ぜられる', 'ずる', WordType.IchidanVerb, WordType.SpecialSuruVerb, [Reason.Irregular, WordType.PotentialOrPassive], 1.0],
  ['たゆたう', 'たゆたう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['たゆとう', 'たゆとう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['のたまう', 'のたまう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['のたもう', 'のたもう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['ましょう', '', WordType.Initial, WordType.MasuStem, [Reason.PoliteVolitional], 1.0],
  // -------------- 3 --------------
  ['いたす', '', WordType.GodanVerb, WordType.MasuStem, [Reason.Humble], 1.0],
  ['いたす', '', WordType.GodanVerb, WordType.NounVS, [Reason.SuruNoun, Reason.Humble], 1.0],
  ['かった', 'い', WordType.Initial, WordType.IAdj, [Reason.Past], 1.0],
  ['下さい', '下さる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['下さい', '下さる', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['くない', 'い', WordType.IAdj, WordType.IAdj, [Reason.Negative], 1.0],
  ['ければ', 'い', WordType.Initial, WordType.IAdj, [Reason.Ba], 1.0],
  ['こよう', 'くる', WordType.Initial, WordType.KuruVerb, [Reason.Volitional], 1.0],
  ['これる', 'くる', WordType.IchidanVerb, WordType.KuruVerb, [Reason.Potential], 1.0],
  ['来れる', '来る', WordType.IchidanVerb, WordType.KuruVerb, [Reason.Potential], 1.0],
  ['來れる', '來る', WordType.IchidanVerb, WordType.KuruVerb, [Reason.Potential], 1.0],
  ['ござい', 'ござる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['ご座i', 'ご座る', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['御座い', '御座る', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['させる', 'る', WordType.IchidanVerb, WordType.IchidanVerb | WordType.KuruVerb, [Reason.Causative], 1.0],
  ['させる', 'する', WordType.IchidanVerb, WordType.SuruVerb, [Reason.Causative], 1.0],
  ['さないない', 'する', WordType.IAdj, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Negative], 1.0],
  ['される', '', WordType.IchidanVerb, WordType.IrrealisStem, [Reason.CausativePassive], 1.0],
  ['される', 'する', WordType.IchidanVerb, WordType.SuruVerb, [Reason.Passive], 1.0],
  ['しうる', 'する', WordType.Initial, WordType.SuruVerb, [Reason.EruUru], 1.0],
  ['しえる', 'する', WordType.IchidanVerb, WordType.SuruVerb, [Reason.EruUru], 1.0],
  ['しない', 'する', WordType.IAdj, WordType.SuruVerb, [Reason.Negative], 1.0],
  ['しよう', 'する', WordType.Initial, WordType.SuruVerb, [Reason.Volitional], 1.0],
  ['じゃう', '', WordType.GodanVerb, WordType.DaDeStem, [Reason.Chau], 1.0],
  ['すぎる', 'い', WordType.IchidanVerb, WordType.IAdj, [Reason.Sugiru], 1.0],
  ['すぎる', '', WordType.IchidanVerb, WordType.MasuStem, [Reason.Sugiru], 1.0],
  ['過ぎる', 'い', WordType.IchidanVerb, WordType.IAdj, [Reason.Sugiru], 1.0],
  ['過ぎる', '', WordType.IchidanVerb, WordType.MasuStem, [Reason.Sugiru], 1.0],
  ['ずれば', 'ずる', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Ba], 1.0],
  ['たまう', 'たまう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['たもう', 'たもう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['揺蕩う', '揺蕩う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['ちゃう', '', WordType.GodanVerb, WordType.TaTeStem, [Reason.Chau], 1.0],
  ['ている', '', WordType.IchidanVerb, WordType.TaTeStem, [Reason.Continuous], 1.0],
  ['ておる', '', WordType.GodanVerb, WordType.TaTeStem, [Reason.HumbleOrKansaiDialect, Reason.Continuous], 1.0],
  ['でいる', '', WordType.IchidanVerb, WordType.DaDeStem, [Reason.Continuous], 1.0],
  ['でおる', '', WordType.GodanVerb, WordType.DaDeStem, [Reason.HumbleOrKansaiDialect, Reason.Continuous], 1.0],
  ['できる', 'する', WordType.IchidanVerb, WordType.SuruVerb, [Reason.Potential], 1.0],
  ['ないで', '', WordType.Initial, WordType.IrrealisStem, [Reason.NegativeTe], 1.0],
  ['なさい', '', WordType.Initial, WordType.MasuStem, [Reason.Respectful, Reason.Imperative], 0.4],
  ['なさい', 'なさる', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 0.4],
  ['なさい', 'なさる', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 0.4],
  ['なさる', '', WordType.GodanVerb, WordType.MasuStem, [Reason.Respectful], 1.0],
  ['なさる', '', WordType.GodanVerb, WordType.NounVS, [Reason.SuruNoun, Reason.Respectful], 1.0],
  ['になる', '', WordType.GodanVerb, WordType.MasuStem, [Reason.Respectful], 1.0],
  ['になる', '', WordType.GodanVerb, WordType.NounVS, [Reason.SuruNoun, Reason.Respectful], 1.0],
  ['ました', '', WordType.Initial, WordType.MasuStem, [Reason.PolitePast], 1.0],
  ['まして', '', WordType.Initial, WordType.MasuStem, [Reason.Polite, Reason.Te], 1.0],
  ['ません', '', WordType.Initial, WordType.MasuStem, [Reason.PoliteNegative], 1.0],
  ['られる', 'る', WordType.IchidanVerb, WordType.IchidanVerb | WordType.KuruVerb, [Reason.PotentialOrPassive], 1.0],
  // -------------- 2 --------------
  ['致す', '', WordType.GodanVerb, WordType.MasuStem, [Reason.Humble], 1.0],
  ['致す', '', WordType.GodanVerb, WordType.NounVS, [Reason.SuruNoun, Reason.Humble], 1.0],
  ['えば', 'う', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['える', 'う', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['得る', '', WordType.IchidanVerb, WordType.MasuStem, [Reason.EruUru], 1.0],
  ['おう', 'う', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['仰い', '仰る', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['仰い', '仰る', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['くて', 'い', WordType.Initial, WordType.IAdj, [Reason.Te], 1.0],
  ['けば', 'く', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['げば', 'ぐ', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['ける', 'く', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['げる', 'ぐ', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['こい', 'くる', WordType.Initial, WordType.KuruVerb, [Reason.Imperative], 1.0],
  ['こう', 'く', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['ごう', 'ぐ', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['しろ', 'する', WordType.Initial, WordType.SuruVerb, [Reason.Imperative], 1.0],
  ['さず', 'する', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Zu], 1.0],
  ['すぎ', 'い', WordType.Initial, WordType.IAdj, [Reason.Sugiru], 1.0],
  ['すぎ', '', WordType.Initial, WordType.MasuStem, [Reason.Sugiru], 1.0],
  ['過ぎ', 'い', WordType.Initial, WordType.IAdj, [Reason.Sugiru], 1.0],
  ['過ぎ', '', WordType.Initial, WordType.MasuStem, [Reason.Sugiru], 1.0],
  ['する', '', WordType.SuruVerb, WordType.NounVS, [Reason.SuruNoun], 1.0],
  ['せず', 'する', WordType.Initial, WordType.SuruVerb, [Reason.Zu], 1.0],
  ['せぬ', 'する', WordType.Initial, WordType.SuruVerb, [Reason.Negative], 1.0],
  ['せん', 'する', WordType.Initial, WordType.SuruVerb, [Reason.Negative], 1.0],
  ['せば', 'す', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['せば', 'する', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Ba], 1.0],
  ['せよ', 'する', WordType.Initial, WordType.SuruVerb, [Reason.Imperative], 1.0],
  ['せる', 'す', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['せる', '', WordType.IchidanVerb, WordType.IrrealisStem, [Reason.Causative], 1.0],
  ['ぜず', 'ずる', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Zu], 1.0],
  ['ぜぬ', 'ずる', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Negative], 1.0],
  ['ぜよ', 'ずる', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Imperative], 1.0],
  ['そう', '', WordType.Initial, WordType.MasuStem, [Reason.Sou], 1.0],
  ['そう', 'い', WordType.Initial, WordType.IAdj, [Reason.Sou], 1.0],
  ['そう', 'す', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['そう', 'する', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Volitional], 1.0],
  ['たい', '', WordType.IAdj, WordType.MasuStem, [Reason.Tai], 1.0],
  ['たら', '', WordType.Initial, WordType.TaTeStem, [Reason.Tara], 1.0],
  ['だら', '', WordType.Initial, WordType.DaDeStem, [Reason.Tara], 1.0],
  ['たり', '', WordType.Initial, WordType.TaTeStem, [Reason.Tari], 1.0],
  ['だり', '', WordType.Initial, WordType.DaDeStem, [Reason.Tari], 1.0],
  ['てば', 'つ', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['てる', 'つ', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['てる', '', WordType.IchidanVerb, WordType.TaTeStem, [Reason.Continuous], 1.0],
  ['でる', '', WordType.IchidanVerb, WordType.DaDeStem, [Reason.Continuous], 1.0],
  ['とう', 'つ', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['とく', '', WordType.GodanVerb, WordType.TaTeStem, [Reason.Toku], 1.0],
  ['とる', '', WordType.GodanVerb, WordType.TaTeStem, [Reason.HumbleOrKansaiDialect, Reason.Continuous], 1.0],
  ['どく', '', WordType.GodanVerb, WordType.DaDeStem, [Reason.Toku], 1.0],
  ['どる', '', WordType.GodanVerb, WordType.DaDeStem, [Reason.HumbleOrKansaiDialect, Reason.Continuous], 1.0],
  ['ない', '', WordType.IAdj, WordType.IrrealisStem, [Reason.Negative], 1.0],
  ['ねば', 'ぬ', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['ねる', 'ぬ', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['のう', 'ぬ', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['べば', 'ぶ', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['べる', 'ぶ', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['ぼう', 'ぶ', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['ませんでした', '', WordType.Initial, WordType.MasuStem, [Reason.PolitePastNegative], 1.0],
  ['ましょうか', '', WordType.Initial, WordType.MasuStem, [Reason.PoliteVolitional], 1.0],
  ['ましたか', '', WordType.Initial, WordType.MasuStem, [Reason.PolitePast], 1.0],
  ['ましょう', '', WordType.Initial, WordType.MasuStem, [Reason.PoliteVolitional], 1.0],
  ['ました', '', WordType.Initial, WordType.MasuStem, [Reason.PolitePast], 1.0],
  ['ません', '', WordType.Initial, WordType.MasuStem, [Reason.PoliteNegative], 1.0],
  ['ますか', '', WordType.Initial, WordType.MasuStem, [Reason.Polite], 1.0],
  ['ます', '', WordType.Initial, WordType.MasuStem, [Reason.Polite], 0.8],
  ['ませ', '', WordType.Initial, WordType.MasuStem, [Reason.Polite, Reason.Imperative], 1.0],
  ['でした', '', WordType.Initial, WordType.MasuStem | WordType.IrrealisStem | WordType.Initial, [Reason.PolitePast], 1.0],
  ['めば', 'む', WordType.Initial, WordType.GodanVerb, [Reason.Ba], 1.0],
  ['める', 'む', WordType.IchidanVerb, WordType.GodanVerb, [Reason.Potential], 1.0],
  ['もう', 'む', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  ['よう', 'る', WordType.Initial, WordType.IchidanVerb | WordType.KuruVerb, [Reason.Volitional], 1.0],
  ['れば', 'る', WordType.Initial, WordType.IchidanVerb | WordType.GodanVerb | WordType.KuruVerb | WordType.SuruVerb, [Reason.Ba], 1.0],
  ['れる', 'る', WordType.IchidanVerb, WordType.IchidanVerb | WordType.GodanVerb, [Reason.Potential], 1.0],
  ['れる', '', WordType.IchidanVerb, WordType.IrrealisStem, [Reason.Passive], 1.0],
  ['ろう', 'る', WordType.Initial, WordType.GodanVerb, [Reason.Volitional], 1.0],
  // Irregular て-form stems
  ['いっ', 'いく', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['おう', 'おう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['こう', 'こう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['そう', 'そう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['とう', 'とう', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['行っ', '行く', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['逝っ', '逝く', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['往っ', '往く', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['請う', '請う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['乞う', '乞う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['恋う', '恋う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['問う', '問う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['負う', '負う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['沿う', '沿う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['添う', '添う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['副う', '副う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['厭う', '厭う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['給う', '給う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['賜う', '賜う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['宣う', '宣う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['曰う', '曰う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  // -------------- 1 --------------
  ['い', 'う', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['い', 'く', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['い', 'ぐ', WordType.DaDeStem, WordType.GodanVerb, [], 1.0],
  ['い', 'る', WordType.Initial, WordType.KuruVerb, [Reason.Imperative], 1.0],
  ['え', 'う', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['か', 'く', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['が', 'ぐ', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['き', 'い', WordType.Initial, WordType.IAdj, [Reason.Ki], 1.0],
  ['き', 'く', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['き', 'くる', WordType.TaTeStem, WordType.KuruVerb, [], 1.0],
  ['き', 'くる', WordType.MasuStem, WordType.KuruVerb, [Reason.MasuStem], 1.0],
  ['ぎ', 'ぐ', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['く', 'い', WordType.Initial, WordType.IAdj, [Reason.Adv], 1.0],
  ['け', 'く', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['げ', 'ぐ', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['こ', 'くる', WordType.IrrealisStem, WordType.KuruVerb, [], 1.0],
  ['さ', 'い', WordType.Initial, WordType.IAdj, [Reason.Noun], 1.0],
  ['さ', 'す', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['し', 'す', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 0.01],
  ['し', 'する', WordType.MasuStem, WordType.SuruVerb, [Reason.MasuStem], 0.01],
  ['し', '', WordType.TaTeStem, WordType.NounVS, [Reason.SuruNoun], 1.0],
  ['し', 'す', WordType.TaTeStem, WordType.GodanVerb, [], 0.01],
  ['し', 'する', WordType.TaTeStem, WordType.SuruVerb, [], 0.01],
  ['ず', '', WordType.Initial, WordType.IrrealisStem, [Reason.Zu], 1.0],
  ['せ', 'す', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['せ', 'する', WordType.Initial, WordType.SpecialSuruVerb, [Reason.Irregular, Reason.Imperative], 1.0],
  ['た', 'つ', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['た', '', WordType.Initial, WordType.TaTeStem, [Reason.Past], 0.9],
  ['だ', '', WordType.Initial, WordType.DaDeStem, [Reason.Past], 1.0],
  ['ち', 'つ', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['っ', 'う', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['っ', 'つ', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['っ', 'る', WordType.TaTeStem, WordType.GodanVerb, [], 1.0],
  ['て', '', WordType.Initial, WordType.TaTeStem, [Reason.Te], 1.0],
  ['て', 'つ', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['で', '', WordType.Initial, WordType.DaDeStem, [Reason.Te], 1.0],
  ['な', 'ぬ', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['な', '', WordType.Initial, WordType.IchidanVerb | WordType.GodanVerb | WordType.KuruVerb | WordType.SuruVerb, [Reason.ImperativeNegative], 1.0],
  ['に', 'ぬ', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['ぬ', '', WordType.Initial, WordType.IrrealisStem, [Reason.Negative], 1.0],
  ['ね', 'ぬ', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['ば', 'ぶ', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['び', 'ぶ', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['べ', 'ぶ', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['ま', 'む', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['み', 'む', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['め', 'む', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['よ', 'る', WordType.Initial, WordType.IchidanVerb, [Reason.Imperative], 1.0],
  ['ら', 'る', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['り', 'る', WordType.MasuStem, WordType.GodanVerb, [Reason.MasuStem], 1.0],
  ['れ', 'る', WordType.Initial, WordType.GodanVerb, [Reason.Imperative], 1.0],
  ['ろ', 'る', WordType.Initial, WordType.IchidanVerb, [Reason.Imperative], 1.0],
  ['わ', 'う', WordType.IrrealisStem, WordType.GodanVerb, [], 1.0],
  ['ん', 'ぬ', WordType.DaDeStem, WordType.GodanVerb, [], 1.0],
  ['ん', 'ぶ', WordType.DaDeStem, WordType.GodanVerb, [], 1.0],
  ['ん', 'む', WordType.DaDeStem, WordType.GodanVerb, [], 1.0],
  ['ん', '', WordType.Initial, WordType.IrrealisStem, [Reason.Negative], 1.0],
];

const deinflectRuleGroups = [];

function getDeinflectRuleGroups() {
  if (!deinflectRuleGroups.length) {
    let prevLen = -1;
    let ruleGroup;

    for (const [from, to, fromType, toType, reasons, weight] of deinflectRuleData) {
      const rule = { from, to, fromType, toType, reasons, weight: weight ?? 1.0 };

      if (prevLen !== rule.from.length) {
        prevLen = rule.from.length;
        ruleGroup = { rules: [], fromLen: prevLen };
        deinflectRuleGroups.push(ruleGroup);
      }
      ruleGroup.rules.push(rule);
    }
  }

  return deinflectRuleGroups;
}

// Returns an array of possible de-inflected versions of |word|.
export function deinflect(word) {
  let result = [];
  const resultIndex = {};
  const ruleGroups = getDeinflectRuleGroups();

  const original = {
    word,
    // Initially, the type of word is unknown, so we set the type mask to
    // match all rules except stems, that don't make sense on their own.
    type: 0xffff ^ (WordType.TaTeStem | WordType.DaDeStem | WordType.MasuStem | WordType.IrrealisStem),
    reasonChains: [],
  };
  result.push(original);
  resultIndex[word] = 0;

  let i = 0;
  do {
    const thisCandidate = result[i];

    if (
      thisCandidate.type & WordType.IchidanVerb &&
      thisCandidate.reasonChains.length === 1 &&
      thisCandidate.reasonChains[0].length === 1 &&
      thisCandidate.reasonChains[0][0] === Reason.MasuStem
    ) {
      continue;
    }

    const word = thisCandidate.word;
    const type = thisCandidate.type;

    if (type & (WordType.MasuStem | WordType.TaTeStem | WordType.IrrealisStem)) {
      const reason = [];

      if (type & WordType.MasuStem && !thisCandidate.reasonChains.length) {
        reason.push([Reason.MasuStem]);
      }

      const inapplicableForm =
        type & WordType.IrrealisStem &&
        thisCandidate.reasonChains.length > 0 && 
        (thisCandidate.reasonChains[0][0] == Reason.Passive ||
          thisCandidate.reasonChains[0][0] == Reason.Causative ||
          thisCandidate.reasonChains[0][0] == Reason.CausativePassive);

      if (!inapplicableForm) {
        result.push({
          word: word + 'る',
          type: WordType.IchidanVerb | WordType.KuruVerb,
          reasonChains: [...thisCandidate.reasonChains, ...reason],
        });
      }
    }

    for (const ruleGroup of ruleGroups) {
      if (ruleGroup.fromLen > word.length) {
        continue;
      }

      const ending = word.slice(-ruleGroup.fromLen);
      const hiraganaEnding = wanakana.toHiragana(ending); // Use wanakana here

      for (const rule of ruleGroup.rules) {
        if (!(type & rule.fromType)) {
          continue;
        }

        if (ending !== rule.from && hiraganaEnding !== rule.from) {
          continue;
        }

        const newWord =
          word.substring(0, word.length - rule.from.length) + rule.to;
        if (!newWord.length) {
          continue;
        }

        const ruleReasons = new Set(rule.reasons);
        if (thisCandidate.reasonChains.flat().some((r) => ruleReasons.has(r))) {
          continue;
        }

        if (resultIndex[newWord] !== undefined) {
          const candidate = result[resultIndex[newWord]];
          if (candidate.type === rule.toType) {
            if (rule.reasons.length) {
              candidate.reasonChains.unshift([...rule.reasons]);
            }
            continue;
          }
        }
        resultIndex[newWord] = result.length;

        const reasonChains = [];
        for (const array of thisCandidate.reasonChains) {
          reasonChains.push([...array]);
        }

        if (rule.reasons.length) {
          if (reasonChains.length) {
            const firstReasonChain = reasonChains[0];

            if (
              rule.reasons[0] === Reason.Causative &&
              firstReasonChain.length &&
              firstReasonChain[0] === Reason.PotentialOrPassive
            ) {
              firstReasonChain.splice(0, 1, Reason.CausativePassive);
            } else if (
              rule.reasons[0] === Reason.MasuStem &&
              firstReasonChain.length
            ) {
              // Do nothing
            } else {
              firstReasonChain.unshift(...rule.reasons);
            }
          } else {
            reasonChains.push([...rule.reasons]);
          }
        }

        const ruleWeight = (thisCandidate.ruleWeight ?? 1.0) * rule.weight;
        const candidate = {
          reasonChains,
          type: rule.toType,
          word: newWord,
          ruleWeight,
        };

        result.push(candidate);
      }
    }
  } while (++i < result.length);

  result = result.filter((r) => r.type & WordType.All);

  // Apply penalties for short words with ambiguous 1-character rules
  for (const r of result) {
    if (!r.ruleWeight) r.ruleWeight = 1.0;
    
    // detect if any 1-character rule was used on a word that is now short
    const isShort = r.word.length <= 4;
    const usedOneCharRule = r.reasonChains.some(chain => 
      chain.some(reason => {
        // This is a heuristic: check if the applied rules for this candidate included a 1-char rule
        // In this implementation, we'll just check if the rule weight was already heavily penalized
        return false; 
      })
    );

    // More precise: if ruleWeight is already low, it might be due to 'し' or 'た'
  }

  return result;
}
