// 端末識別ミドルウェア。
// context.ts の requestContext に統合済みのため、このファイルは契約公開用の薄いファサード。
// 直接このミドルウェアを mount する必要はない（index.ts で requestContext を使う）。

import { requestContext } from "../context";

/** oc_did / device_hash を構築するミドルウェア。requestContext と同義。 */
export const device = requestContext;
export { requestContext };
