/**
 * Measured bodies for the bot mark, in body units (the sphere's radius is 1.18 of them at size 1).
 * Each body is built the way it is drawn: turned on a lathe from a profile, pushed back from an
 * outline with bevelled edges, lofted from an outline into a pillow, made of overlapping balls, or
 * a rounded gem. Packed numbers are two base-64 characters each, at 1/2000 steps from -1.024.
 * Written from local measurements of the reference; edit by re-measuring, not by hand.
 */

/** Eye placement on a body: eye width and height, the gap between the eyes and how far down they sit. */
export type BotMarkEyePlacement = readonly [
  width: number,
  height: number,
  gap: number,
  shift: number,
];

/** Where the eyes wrap: around the body's height between two heights, or along its length. */
export type BotMarkWrapSeat = { wrap: readonly [y0: number, y1: number, eyeY: number] };
export type BotMarkWrapXSeat = { wrapX: readonly [x0: number, x1: number] };

type Common = { size: number; eyes: BotMarkEyePlacement };

export type BotMarkBodySpec = Common &
  (
    | { kind: "revolve"; top: number; bottom: number; radii: string; seat: BotMarkWrapSeat }
    | {
        kind: "extrusion";
        halfDepth: number;
        bevel: number;
        convex: boolean;
        face: number;
        outline?: string;
      }
    | { kind: "loft"; depth: number; outline: string }
    | { kind: "slab"; halfDepth: number; edge: number; outline: string; face: number }
    | { kind: "crystal"; face: number }
    | {
        kind: "pill";
        axis: "x" | "y";
        reach: number;
        radius: number;
        seat: BotMarkWrapSeat | BotMarkWrapXSeat;
      }
    | { kind: "balls"; balls: string; seat: BotMarkWrapSeat }
  );

export const BOT_MARK_BODY_SPECS = {
  arch: {
    size: 1.17,
    eyes: [0.1924, 0.4218, 0.448, 0.16],
    kind: "revolve",
    top: 0.99956,
    bottom: -0.99955,
    radii:
      "ggEj9DaHABABDAADABBBBDBDBBDDDBDDFBFDDFFDFDDBAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCAABAADCDBAFBDDFFF" +
      "NHPPVhBvClG",
    seat: { wrap: [-0.99955, 0.99956, 0.15993] },
  },
  bean: {
    size: 1.17,
    eyes: [0.2028, 0.4446, 0.4608, 0.12],
    kind: "balls",
    balls:
      "-gE9gEAAAAoGnGvMwMwMvMvMwMoGnGnGoGAAoGnGvMwMAAnGoGAAnGoGspEj8Eof3SgZ_xB4rBnGvlBw3C39Co4BnGn4" +
      "B4rB4rB_xB_YoxC32DgrCgyB_xB_qCw-Bw3C_qC_jDo1F3oF4kC42D07Gz7GHIvBwBrBsBvBwBAALMHIPQtDuDAABCnB" +
      "oBpDqDRSjGkG",
    seat: { wrap: [-0.99955, 0.99956, 0] },
  },
  capsule: {
    size: 1.17,
    eyes: [0.2106, 0.4617, 0.36045, 0.12],
    kind: "pill",
    axis: "y",
    reach: 0.36265,
    radius: 0.63691,
    seat: { wrap: [-0.99955, 0.99956, 0] },
  },
  cloud: {
    size: 1.3455,
    eyes: [0.21294, 0.46683, 0.47002, 0.07],
    kind: "loft",
    depth: 0.72,
    outline:
      "61H9zHHBTDRHLNFTAHXGbMfUjBWhBaBlBgBlBkBNiBLoBhBSDfYhBcfchBiBfgBCbiBZiBXiBTKfcnBQCfkBdkBZkBXk" +
      "BRgBGJcFYASIOKKKSCYDcHgBNkBhBCcxDNGQESAYHKaJcNgBViBXiBbiBdAgBfehBchBYfUfDWCiBbiBdgBfejBBahBU" +
      "hBShBMbEXHFPJPkB8BkBdOfkiE5lEFhBehBgBhBiBdiBbiBEVgBPeNeHaDYIGQOIUN9BvBFaGFUAQEOIKMEKQAUDWHa1" +
      "B1COEMMOISCWBYFcPIgBTiBZkBdkBfiBfBehBcjBajBUfQpBJKwBqBfgBfcfajBBWhBUhBQdIXCTDNJHJNBTCTEVKHIu" +
      "DATDPLHRDHZGdMfQhBUhBaDhBcfgBV2CjBKjBW",
  },
  clover: {
    size: 1.0881,
    eyes: [0.23296, 0.51072, 0.5591, -0.02],
    kind: "extrusion",
    halfDepth: 0.36,
    bevel: 0.22,
    convex: false,
    face: 0.36,
    outline:
      "wqHlpHcTADBBDDBBFAFBDBDDDBDBFBBFBBFBBDBDDADDBBAFABDABBABBBAABCBBCBCAAAACACCBECACAECCCABBBDCD" +
      "BADCBBABAAAABCBCCBCAACCCACCAECCCCCEAGAEECCGAGCCGCCGCECEEECECGAGCCEECCECQZzCZQCECCEECCGAGCECE" +
      "EECECGCCGCCGAGCCEEAGAECCCCCEACCACCCAACBCCBCBAAAABABBCDABDCDBBBACCCEACACEBCCACAAAACBCBBCBAABB" +
      "BABBADBAFABBDDADDBDBBFBBFBBFBDBDDDBDBFAFBBDDBBDATcggEjiEBBBDABABDCBBABAAAABCBCCBCAACCCACCAEC" +
      "AGACCEEAEECECCGCCGCCGCECEEECECGAGCCEECCEAUbzCbUAECCEECCGAGCECEEECECGCCGCCGCCECEEAEECCAGACEAC" +
      "CACCCAACBCCBCBAAAABABBCDBABADBBBACCCEBECAEBCCACAAAACBCBBCBAABBBABBADBBBBBDAFADDBBFAFBBFBBFBD" +
      "BDDDBDBFAFBBDDBBDBPa0CaPBDBBDDBBFAFBDBDDDBDBFBBFBBFAFBBDDAFADBBBBBDABBABBBAABCBBCBCAAAACACCB" +
      "EACEBECCC",
  },
  crystal: {
    size: 1.3806,
    eyes: [0.1612, 0.3534, 0.3712, 0.12],
    kind: "crystal",
    face: 0.55426,
  },
  cylinder: {
    size: 1.17,
    eyes: [0.2392, 0.5244, 0.47872, 0.12],
    kind: "revolve",
    top: 0.99956,
    bottom: -0.99955,
    radii:
      "ggE16DBIHADADDBDBFDFFFFHFFJJHJHNJNHBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHNJNHJHJJFFHFFFFDFBDB" +
      "DDADAHIB",
    seat: { wrap: [-0.99955, 0.99956, 0] },
  },
  dome: {
    size: 1.17,
    eyes: [0.2132, 0.4674, 0.47872, 0.106],
    kind: "revolve",
    top: 0.7176,
    bottom: -0.71759,
    radii:
      "ggEn9DWFBCBBABAABAABBBAADAADABBBADADABBDABBBDABDADADADBADADABBBBBABBABBABABAAAABCDAABAFCFBDF" +
      "FDNDXbpBtD",
    seat: { wrap: [-0.71759, 0.7176, 0] },
  },
  egg: {
    size: 1.17,
    eyes: [0.2392, 0.5244, 0.43366, 0.113],
    kind: "revolve",
    top: 0.99956,
    bottom: -0.99955,
    radii:
      "ggEr9DIADCABCBACBBCABABAAADCDABADADADBBBDBDBDBFBDDBFDDBFDDDDDFBDFBDFBDDDBDDBDBDBBDADADBABDCB" +
      "BCDACFAK",
    seat: { wrap: [-0.99955, 0.99956, 0] },
  },
  flower: {
    size: 1.3923,
    eyes: [0.19292, 0.42294, 0.38298, 0.12],
    kind: "extrusion",
    halfDepth: 0.36,
    bevel: 0.22,
    convex: false,
    face: 0.36,
  },
  gem: {
    size: 1.17,
    eyes: [0.2392, 0.5244, 0.50125, 0.12],
    kind: "revolve",
    top: 0.99956,
    bottom: -0.99955,
    radii:
      "ggE5-DKOIGGCGCCECACCCAAACBCBBCBBBABDADBBDBFBDDFDFFHJXXJHFFDFDDBFBDBBDADBABBBCBBCBCAAACCCACEC" +
      "CGCGIEQK",
    seat: { wrap: [-0.99955, 0.99956, 0] },
  },
  heart: {
    size: 1.3572,
    eyes: [0.18658, 0.40903, 0.44621, 0.052],
    kind: "loft",
    depth: 0.62,
    outline:
      "60H_yHJJLHLLJJLLHLJJJHFJFHDDFDADAACACCEGCIEGIBHDHDDDDBBBAAAECEEEIEKGIIMIKMKKMMIOKKKKKKIIIGGB" +
      "DDDBDADABABAAAACAACCAECECIGIEGCCCABBBHDFJDDBDADABABAAACBCACCAECECGEBDJDLygEl8DGEAEACBABBDDDF" +
      "HDHHHJHHLJHLHLHLHJHHJFHFQsEFFHFJHHJJJHLHLJJHJJHHHFHDHBFBBBBCAAECECIEEKEIGECEECCAEAACAAAAABAB" +
      "ABDBBDEKMMMMMOMMMOMKOIABBDBBABBCBBCACBCCCAEAEEEEGGIGE",
  },
  hex: {
    size: 1.2519,
    eyes: [0.26, 0.57, 0.64, 0.12],
    kind: "extrusion",
    halfDepth: 0.36,
    bevel: 0.22,
    convex: true,
    face: 0.36,
    outline:
      "mxHrxHJJJLJJJLJJHCBAAACBAACBAACBAAACAAACBAACBAAABAAACBAACBAACBAAACBIKKMKKKMKKKGAAAAAAAAAAAAA" +
      "AAAAAAGKKKMKKKMKKIBCAAABCAABCAABCAAABAAABCAABCAAACAAABCAABCAABCAAABCHJJLJJJLJJJFAAAAAAAAAAAA" +
      "AAAAAAAy1Cz5CGGGGGGGGGGCAAACBAAAAAAAAAAAACBGOMMMMMMMMOGBCAAAAAAAAAAAABCAAACGGGGGGGGGGGAAAAAB" +
      "CAAAAABCAAAAAFFFFFFFFFFFBAAABCAAAAAAAAAAAABCFNLLLLLLLLNFCBAAAAAAAAAAAACBAAABFFFFFFFFFFFAAAAA" +
      "CBAAAAACBAAAAA",
  },
  house: {
    size: 1.17,
    eyes: [0.22951, 0.50316, 0.51251, 0.185],
    kind: "extrusion",
    halfDepth: 0.36,
    bevel: 0.22,
    convex: true,
    face: 0.36,
    outline:
      "0JvJIKIIKIIIKIKGKIKEAAAAAAAAAAAAAAAAAABCAAAAAAAAAAAAAAAAAADJHJFJHJHHHJHHJFFAAAAAAAAAAAAAAAAA" +
      "AAAAADFHDJDHHDJDHFHFHBAAAAAABCAAAAAAAABCAAAAABCAAABCAAAAABCAAAAAAAABCAAAAAACIIEIIGGGIIGGGIIC" +
      "AAAAAAAAAAAAAAAAAAAAAAslBvpBIIIKIIIKIKGKIKIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEIKIKGKIKI" +
      "IIKIIIGCBAAACBAAACBAAACBAAACBBDDBBFBDBDDBDDBDBCBAAACBAAACBAAACBADLJJLJJJLJJJLJJLDABCAAABCAAA" +
      "BCAAABCBDBDDBDDBDBFBBDDBBCAAABCAAABCAAABCAAABC",
  },
  leaf: {
    size: 1.17,
    eyes: [0.1872, 0.4104, 0.448, 0.04],
    kind: "revolve",
    top: 0.99956,
    bottom: -0.99955,
    radii:
      "ggEr_DMMIIEGEEECECCACCBCAABABBADBBDBBFBFBDFDDFDDFDFFDDFFDFDDFDDFDBFBFBBDBBDABBABAACBCCACCECE" +
      "EEGGEKMM",
    seat: { wrap: [-0.99955, 0.99956, 0] },
  },
  pebble: {
    size: 1.2168,
    eyes: [0.2392, 0.5244, 0.5463, 0.12],
    kind: "revolve",
    top: 0.90759,
    bottom: -0.90758,
    radii:
      "ggEj8DBAEBBCDCDCBBABBADADADDADBDBDDBDDDBFBDFBDDFBFBFDDDFBFDDFDDDDFBFDFBFBFDBFDBDDBDAFCDABAAA" +
      "DCCDACCB",
    seat: { wrap: [-0.90758, 0.90759, 0] },
  },
  shield: {
    size: 1.17,
    eyes: [0.2679, 0.58733, 0.44493, 0.12],
    kind: "revolve",
    top: 0.99956,
    bottom: -0.99955,
    radii:
      "ggEn4DEBVDNHLJHNHJNHJLJJJJLHJHLDDCBABAABABABBAABBBABBBADABBBADBBBADBBBBBDADADBBBBBBDADBADBBB" +
      "ADBBBBAC",
    seat: { wrap: [-0.99955, 0.99956, 0] },
  },
  sparkle: {
    size: 1.521,
    eyes: [0.18382, 0.40299, 0.41216, 0],
    kind: "extrusion",
    halfDepth: 0.36,
    bevel: 0.22,
    convex: false,
    face: 0.36,
    outline:
      "o2EpyEBFFFbFFFFFFFDLBDDBDBDBDDMAAA-DBBFBvDAwBBpBBOAJAGADBIBHAmDHDDSJHJJLJvBBGBBCBAeNPPPNNeBc" +
      "AHAIAhBDmBAJAKBJCKCtBAkBACAJAMAFBEAABEADBGAFAKAACNAKA9BB-BABAECHCFAIAHBKBDBBAAAGABADAMBLAOAN" +
      "BQA3CB2CAJAMANAOCPBSAhCA8BABADACABAECLAOCTAWAnDBBAyBBBABBABABAVBABBAABAXCIGGaGGGIEOGCECEECGC" +
      "CGCGCLAXAKBHCKBFBGAHAUAvEIGGGIGIGIGKGI0BACAFBlBKmBBABEAHCTWWSSSQQlDAKBAAHB0CEI5CBAAEBCBBAmDG" +
      "GCGEEEECClEAEASAZAwDEC5BCCCACACAAACAAAYACBCBs0Hn0HVRVTCJJHJFJFFaDFBBFBBDBB0EABC7BBBABgCAbAcB" +
      "FBGABBEADAGAlCABBTDABABAmDAHAEAEBrDAAGGEG4BAiBAHBKAfAgBAHAIAHAKBbAYACAHCIAFCACABCABACCDAEAAC" +
      "FAEBTCUABCAAABAACABAACABAAAACABCBCACDAEBABEBJCICBACBACBCBCABBCCAABCAAAAAAAAAAAAACBCECAtEECGC" +
      "GEEGEGRIKIMIMMMMUUWSCMIMKIVGGEGGCGEGCEEEE_EAMBBBGAFAEABAECLAsCCCCBEBCACBCBCxCADCMAwCA9CCEAFA" +
      "WAsDBBPFFHHxCAGABADByBBFnBAAAACBAAAkBDDDDDDDBFBAAAABCAAFBB6EDFDFFDFFFFFFFFKJLLJN",
  },
  square: {
    size: 1.0413,
    eyes: [0.25533, 0.55975, 0.52941, 0.12],
    kind: "extrusion",
    halfDepth: 0.36,
    bevel: 0.22,
    convex: true,
    face: 0.36,
    outline:
      "iD9CKKIKKIKIKKKIKIEBCABCABCABCBCABCABCABCABCABCABCBCABCABCABCDHJHJJJHJHJJHJJDAAAAAAAAAAAAAAA" +
      "AAAAAAAAAAAAAAAAAAAAAAAAAAADJJHJJHJHJJJHJHDCBACBACBACBCBACBACBACBACBACBACBCBACBACBACBEIKIKKK" +
      "IKIKKIKKEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAo8Gh4GHJHJJJHJHJJHJJDAAAAAAAAAAAAAAAAAAAA" +
      "AAAAAAAAAAAAAAAAAAAAAADJJHJJHJHJJJHJHDCBACBACBACBCBACBACBACBACBACBACBCBACBACBACBEIKIKKKIKIKK" +
      "IKKEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEKKIKKIKIKKKIKIEBCABCABCABCBCABCABCABCABCABCAB" +
      "CBCABCABCABC",
  },
  squircle: {
    size: 1.17,
    eyes: [0.2392, 0.5244, 0.5632, 0.12],
    kind: "slab",
    halfDepth: 0.28,
    edge: 0.11,
    outline:
      "-8H98HBBHHNPVZffffXRLDBEEGEECABDDFDDCEMSYgBgBgBgBaWQOIICCACCIIOQWagBgBgBgBYSMECDDFDDBACEEGEE" +
      "BDLRXffffZVPNHHBggEloEBDDFDDCEMSYgBgBgBgBaWQOIICCACCIIOQWagBgBgBgBYSMECDDFDDBACEEGEEBDLRXfff" +
      "fZVPNHHBBABBHHNPVZffffXRLDBEEGEE",
    face: 0.28,
  },
  star: {
    size: 1.4976,
    eyes: [0.18478, 0.44966, 0.41913, 0.12],
    kind: "extrusion",
    halfDepth: 0.3,
    bevel: 0.18,
    convex: false,
    face: 0.3,
    outline:
      "4sDnrDQKMGIAEDAHFLJPBBCAAABGQQKMGGCSAAAAAAPHHFLJLLPLRRRTTTAAABCAUWSUUUSWUACBAAATTTRRRLPLLJLF" +
      "HHPAAAAAASCGGMKQQGBAAACBBPJLFHADEAIGMKQCCBAAACFPPJLFFBRAAAAABUGIGMKMMQMSSSUUUAAACBATVRTTTRVT" +
      "ABCAAAUUUSSSMQMMKMGIGUBAAAAARBFFLJPPFCAAABC6pHrmHRNPNRNPPNRNPNRTBCABCAUQMSQSUWOABCAAANTRPNNJ" +
      "JFDDAACGHBCBCBCGFFDAEGGFBCBCBCIFBAAEEGKKOOOWSOAABCAANVTRPRNLVABCABCUSOQOSOQQOSOQOSUCBACBAVLN" +
      "RPRTVNAACBAAOSWOOOKKGEEAABFICBCBCBFGGEADFFGCBCBCBHGCAADDFJJNNPRTNAAACBAOWUSQSMQUACBACB",
  },
  tablet: {
    size: 1.3923,
    eyes: [0.2132, 0.4674, 0.58778, 0.02],
    kind: "pill",
    axis: "x",
    reach: 0.35005,
    radius: 0.64759,
    seat: { wrapX: [-0.97763, 0.97763] },
  },
  teardrop: {
    size: 1.31812,
    eyes: [0.20779, 0.45554, 0.45261, 0.18],
    kind: "revolve",
    top: 0.99932,
    bottom: -0.99971,
    radii:
      "ggE_9DAAAAABCBCBACBAAABCCECCCECCCCCEACAEABHHFFHDHFFDHDDHBHDDFDDFDFBFBFDDBFBDDBDBDBBBDBADBABB" +
      "BAABBBGB",
    seat: { wrap: [-0.99973, 0.9993, -0.00021] },
  },
  wedge: {
    size: 1.35907,
    eyes: [0.2132, 0.4674, 0.46771, 0.18],
    kind: "revolve",
    top: 0.86567,
    bottom: -0.86566,
    radii:
      "ggEp-DKABABCABCBAAAAABCBAAAABAAAABCAACCAACCBCACBCAAAAAAAABCBABAADFBDFDDFDFFDHDDHFFFFFFHFFFHF" +
      "HFFHFFFD",
    seat: { wrap: [-0.86566, 0.86567, 0] },
  },
} as const satisfies Record<string, BotMarkBodySpec>;

export type BotMarkBodyShape = keyof typeof BOT_MARK_BODY_SPECS;

/**
 * Unpacks a run of packed numbers holding `stride` interleaved channels, stored one channel after
 * another. Each character carries five bits, its sixth bit set while more follow; a number is the
 * zigzagged change from the straight-line guess off the two before it in its channel.
 */
export function unpackBodyNumbers(packed: string, stride = 1): number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const steps: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of packed) {
    const digit = alphabet.indexOf(char);
    value += (digit & 31) * 2 ** shift;
    shift += 5;
    if (digit & 32) continue;
    steps.push(value % 2 === 0 ? value / 2 : -(value + 1) / 2);
    value = 0;
    shift = 0;
  }
  const count = steps.length / stride;
  const out = new Array<number>(steps.length);
  for (let channel = 0; channel < stride; channel += 1) {
    let [previous, before] = [0, 0];
    for (let index = 0; index < count; index += 1) {
      const next = 2 * previous - before + steps[channel * count + index]!;
      out[index * stride + channel] = next / 2000 - 1.024;
      [before, previous] = [previous, next];
    }
  }
  return out;
}
