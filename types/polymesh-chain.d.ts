/**
 * Polymesh type augmentations for `@polkadot/api`. Without them polkadot-js
 * knows only the generic Substrate surface — storage results come back as bare
 * `Codec` and every Polymesh-specific pallet is invisible.
 *
 * This must stay a `.d.ts`. The package ships real `.js` files alongside its
 * declarations, so importing it from an ordinary `.ts` file emits a runtime
 * import — and everything under `lib/chain/` is deliberately unreachable until
 * a user connects a wallet (see `npm run assert:lazy`). Declared here the
 * augmentation is compile-time only, picked up through tsconfig's include glob,
 * and no bundler ever sees it. The package is a devDependency for that reason.
 *
 * Its `typesBundle` is also unused: that exists for chains whose metadata does
 * not describe its own types, and Polymesh's runtime carries metadata v14+.
 *
 * These types describe the current runtime only — v6/v7 storage shapes are not
 * here and never will be, which is why `compat.ts` keeps its probing and
 * fallbacks.
 */

import '@polymeshassociation/polymesh-types/polkadot/augment-types';
import '@polymeshassociation/polymesh-types/polkadot/augment-api';
