// 既定のペットの絵（画像はオーケストレーターが生成して `public/pet/` に置く）。
// 利用者のアップロード画像は characterId "custom" で、画像はブラウザにだけ保存する（PetUI の settings.ts）。

export interface PetCharacter {
  id: string;
  /** 選択肢の表示名。 */
  label: string;
  /** 既定のペットの名前（利用者が変えられる）。 */
  defaultName: string;
  /** 透過 PNG（正方形）。 */
  src: string;
}

export const PET_CHARACTERS: readonly PetCharacter[] = [
  { id: "cat", label: "ねこ", defaultName: "ミケ", src: "/pet/cat.png" },
  { id: "dog", label: "いぬ", defaultName: "ポチ", src: "/pet/dog.png" },
  { id: "bird", label: "ことり", defaultName: "ピヨ", src: "/pet/bird.png" },
  { id: "robot", label: "ロボ", defaultName: "ロボ太", src: "/pet/robot.png" },
];

export const DEFAULT_PET_CHARACTER_ID = "cat";
