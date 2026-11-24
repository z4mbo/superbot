/**
 * Measured bodies for the bot mark. Each entry is a body's front outline (128 radii, in body
 * radii, packed two base-64 characters per radius at 1/2000 steps, counter-clockwise from the
 * right), how it fills out in depth, and where its eyes sit. Written from local measurements of
 * the reference's silhouettes at several turns; edit by re-measuring, not by hand.
 */

export type BotMarkBodyKind =
  | { type: "lathe"; axis: "x" | "y"; squeeze: number }
  | { type: "slab"; depth: number; bevel: number };

/** Eyes sit `gap` either side of the middle at height `y`, on a flat face `front` deep or around a column of radius `wrap`, scaled from the sphere's eyes. */
export type BotMarkBodySeat = {
  gap: number;
  y: number;
  scaleX: number;
  scaleY: number;
  front?: number;
  wrap?: number;
};

export type BotMarkBodySpec = {
  outline: string;
  kind: BotMarkBodyKind;
  seat: BotMarkBodySeat;
  gazeScale?: number;
};

export const BOT_MARK_BODY_SPECS = {
  arch: {
    outline:
      "U1U3U7VEVPVeVxWIWjXCXlYJYrZNZvaPaubNbpcFcfc3dOdjd1eGeVeiese0e5e9e-e9e5e0eseieVeGd1djdOc3cfcFbpbNauaPZvZNYrYJXlXCWjWIVxVeVPVEU7U3U1U3U7VEVPVeVxWIWjXDXnYSZDZ8a8cHdde_griQjQjVi2iLhgg5gXf8flfUfIfBe-fBfIfUflf8gXg5hgiLi2jVjQiQgre_ddcHa8Z8ZDYSXnXDWjWIVxVeVPVEU7U3",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.216, y: 0.001, scaleX: 0.69, scaleY: 0.734, front: 0.62 },
  },
  bean: {
    outline:
      "XtXvXyXzX1X2X4X9YCYHYMYRYaYkYuY4ZFZSZhZyaDaWaqa_bTbrcGcfc2dMdmeBeZeufAfPfbfqf2f_gFgFgBf6fvfffLe1ead7dZczcKbea2aOZjY9YYX1XWW8WqWfWaWfWqW8XWX1YYY9ZjaOa2becKczdZd7eae1fLfffvf6gBgFgFf_f2fqfbfPfAeueZeBdmdMc2cfcGbrbTa_aqaWaDZyZhZSZFY4YuYkYaYRYMYHYCX9X4X2X1XzXyXv",
    kind: { type: "lathe", axis: "y", squeeze: 0.9 },
    seat: { gap: 0.222, y: -0.117, scaleX: 0.735, scaleY: 0.747, front: 0.68 },
  },
  capsule: {
    outline:
      "TvTwT1T9UIUWUoU9VXV1WYW_XoYPY2ZcaBakbFblcEcgc6dTdpd8eNecepeye4e8e-e8e4eyepeceNd8dpdTc6cgcEblbFakaBZcY2YPXoW_WYV1VXU9UoUWUIT9T1TwTvTwT1T9UIUWUoU9VXV1WYW_XoYPY2ZcaBakbFblcEcgc6dTdpd8eNecepeye4e8e-e8e4eyepeceNd8dpdTc6cgcEblbFakaBZcY2YPXoW_WYV1VXU9UoUWUIT9T1Tw",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.174, y: -0.119, scaleX: 0.768, scaleY: 0.803, front: 0.6 },
  },
  cloud: {
    outline:
      "h5hBgAe6dpdPdld_eVeme0e8fCfDfAe4erebeHdvdTczcObna7aNZbYnY5ZiaIatbQbycRcudIdfd0eHeWejeteze2e3e1evenebeOd8dodRc4ccb-bebXcud-fIgMhHh-itjVj4kTkpk3k-k_k5ktkakAjgi5iLhXgdfaeUdEbva4bBbVbmb2cDcPcZcfckcncnclchcbcScHb6brbZbFbFcDddeuf1g3hwijjPjykQklk0k8k8k2kokTj4jVir",
    kind: { type: "slab", depth: 1.8, bevel: 0.9 },
    seat: { gap: 0.268, y: -0.08, scaleX: 0.934, scaleY: 0.934, front: 0.82 },
  },
  clover: {
    outline:
      "YjZkajbdcVdId4ejfLftgMgmg8hMhYhfhihfhYhMg8gmgMftfLejd4dIcVbdajZkYjZkajbdcVdId4ejfLftgMgmg8hMhYhfhhhfhYhMg8gmgMftfLejd4dIcVbdajZkYjZkajbdcVdId4ejfLftgMgmg8hMhYhfhihfhYhMg8gmgMftfLejd4dIcVbdajZkYjZkajbdcVdId4ejfLftgMgmg8hMhYhfhihfhYhMg8gmgMftfLejd4dIcVbdajZk",
    kind: { type: "slab", depth: 0.7, bevel: 0.21 },
    seat: { gap: 0.258, y: 0.018, scaleX: 0.826, scaleY: 0.826, front: 0.34 },
  },
  crystal: {
    outline:
      "XTXUXaXjXwYBYWYvZNZxaabKcBdAeCeue-fBfJfWfogAgdhAhqiajTkUlfm1oYp2qap2oYm1lfkUjTiahqhAgdgAfofWfJfBe-eueCdAcBbKaaZxZNYvYWYBXwXjXaXUXTXUXaXjXwYBYWYvZNZxaabKcBdAeCeue-fBfJfWfogAgdhAhqiajTkUlfm1oYp2qap2oYm1lfkUjTiahqhAgdgAfofWfJfBe-eueCdAcBbKaaZxZNYvYWYBXwXjXaXU",
    kind: { type: "lathe", axis: "y", squeeze: 0.9 },
    seat: { gap: 0.221, y: -0.14, scaleX: 0.765, scaleY: 0.725, wrap: 0.68 },
  },
  cylinder: {
    outline:
      "aeagamaxa_bSbqcHcqdSeBe3f0gnhEhThXhThLhAgygjgUgGf4frfgfWfNfHfCe_e-e_fCfHfNfWfgfrf4gGgUgjgyhAhLhThXhThEgnf0e3eBdScqcHbqbSa_axamagaeagamaxa_bSbqcHcqdSeBe3f0gnhEhShXhThLhAgygjgUgGf4frfgfWfNfHfCe_e-e_fCfHfNfWfgfrf4gGgUgjgyhAhLhThXhShEgnf0e3eBdScqcHbqbSa_axamag",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.235, y: -0.119, scaleX: 0.909, scaleY: 0.912, wrap: 0.84 },
  },
  dome: {
    outline:
      "cQbxbTa3adaEZuZYZEYyYhYRYCX1XpXeXTXKXBW6WzWtWnWiWeWaWYWVWSWRWQWPWPWPWQWRWSWVWYWaWeWiWnWtWzW6XBXKXTXeXpX1YCYRYhYyZEZYZuaEada3bTbxcQcydWd7ejfNf6gohZiMjDj-kwkki-hGfceAcxbsavZ7ZNYmYEXnXPW7WrWeWWWRWPWRWWWeWrW7XPXnYEYmZNZ7avbscxeAfchGi-kkkwj-jDiMhZgof6fNejd7dWcy",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.234, y: -0.105, scaleX: 0.788, scaleY: 0.813, front: 0.9 },
  },
  egg: {
    outline:
      "ZYZRZLZHZDZBZAZAZDZGZLZRZaZkZvZ8aLacaubCbXbucGcec4dRdpeAeUemeze7e-e7ezemeUeAdpdRc4cecGbubXbCauacaLZ8ZvZkZaZRZLZGZDZAZAZBZDZHZLZRZYZgZqZ0Z-aKaWajawa-bMbbbqb5cIcWcmc0dDdRdfdsd4eFePeaejerexe3e7e9e-e9e7e3exerejeaePeFd4dsdfdRdDc0cmcWcIb5bqbbbMa-awajaWaKZ-Z0ZqZg",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.213, y: -0.112, scaleX: 0.909, scaleY: 0.912, wrap: 0.8 },
  },
  flower: {
    outline:
      "YVaRb2dLeSfOf_glhDhXhhhihbhKgwgNfgendkcUa0ZAZqbXcxd8e7fvgZg6hRhfhkhfhRg6gZfve7d8cxbXZqZAa0cUdkenfggNgwhKhbhihhhXhDglf_fOeSdLb2aRYVaRb2dLeSfOf_glhDhXhhhihbhKgwgNfgendkcUa0ZAZqbXcxd8e7fvgZg6hRhfhkhfhRg6gZfve7d8cxbXZqZAa0cUdkenfggNgwhKhbhihhhXhDglf_fOeSdLb2aR",
    kind: { type: "slab", depth: 0.9, bevel: 0.27 },
    seat: { gap: 0.226, y: -0.141, scaleX: 0.875, scaleY: 0.876, front: 0.42 },
  },
  gem: {
    outline:
      "eqeheOd6dmdRc-cscccNcAb2bsbmbhbebebfbjbpbxb7cHcVclc3dKdfd0eKefeye-eyefeKd0dfdKc3clcVcHb7bxbpbjbfbebebhbmbsb2cAcNcccsc-dRdmd6eOeheqeheOd7dmdRc-cscccNcAb2btbmbhbebebfbjbpbxb7cHcVclc3dKdfd0eKefeye-eyefeKd0dfdKc3clcVcHb7bxbpbjbfbebebhbmbtb2cAcNcccsc-dRdmd7eOeh",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.244, y: -0.119, scaleX: 0.882, scaleY: 0.912, front: 0.9 },
  },
  heart: {
    outline:
      "hhiPi4jej-kZkwlClOlWlZlWlPlDk0kfkHjsjNiriFhdgzgGfWeldzdAcKbTacZkY2ZlacbTcKc_d0emfWgFgyheiFiqjNjskIkfkzlElPlWlYlWlOlCkxkaj-jei4iOhhguf4e_eCdFcPbga3aUZ2ZeZJY6YuYmYiYiYlYtY4ZHZbZzaQaybXb4cTcmc1c9dAc-c1cmcSb4bYayaQZzZbZHY4YtYlYhYiYmYuY5ZJZeZ2aUa3bfcOdFeCe_f4gu",
    kind: { type: "slab", depth: 1.4, bevel: 0.7 },
    seat: { gap: 0.257, y: -0.06, scaleX: 0.825, scaleY: 0.825, front: 0.7 },
    gazeScale: 0.6,
  },
  hex: {
    outline:
      "eBeDeKeWene9fYf4gcg2hFhIg8glgFfifFetebeOeFeBeCeHeRege0fOftgQgvhChIhCgvgQftfOe1eheSeHeCeBeFeOebetfFfigFglg8hIhFg2gcf4fYe9eneWeKeDeBeDeKeWene9fYf4gcg2hFhIg8glgFfifFetebeOeFeBeCeHeSehe1fOftgQgvhChIhCgvgQftfOe1eheSeIeCeBeFeOebetfFfigFglg8hIhFg2gcf4fYe9eneWeKeD",
    kind: { type: "slab", depth: 0.8, bevel: 0.24 },
    seat: { gap: 0.34, y: -0.127, scaleX: 1.061, scaleY: 1.061, front: 0.38 },
  },
  house: {
    outline:
      "dWdZdedkdmdldhdZdMc8cocSb5bgbKa5asakagagakasa5bKbfb6cZc_dneKeme4e_e4emeKdnc_cZb6bfbKa5atakagagakata5bKbgb5cScoc8dMdZdhdldmdjdedZdWdZdgdrd7eRerfLfxgehSiOjTkjl3m6ninpnOmZlQkHjIiRhig5gXf8flfUfIfBe-fBfIfUflf8gXg5hiiRjIkHlQmZnOnpnim6l3kjjTiOhSgefxfLereRd7drdgdZ",
    kind: { type: "slab", depth: 0.7, bevel: 0.21 },
    seat: { gap: 0.254, y: -0.182, scaleX: 0.875, scaleY: 0.875, front: 0.36 },
  },
  leaf: {
    outline:
      "YHYHYIYJYKYMYOYRYUYYYdYiYpYwY5ZDZOZaZoZ3aIaaaubEbcb2cRctdMdreKeoe-eoeKdrdMctcRb2bcbEauaaaIZ3ZoZaZOZDY5YwYpYiYdYYYUYRYOYMYKYJYIYHYHYHYIYJYKYMYOYRYUYYYdYiYpYwY5ZDZOZaZoZ3aIaaaubEbcb2cRcudMdreKeoe-eoeKdrdMcucRb2bcbEauaaaIZ3ZoZaZOZDY5YwYpYiYdYYYUYRYOYMYKYJYIYH",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.221, y: -0.04, scaleX: 0.713, scaleY: 0.714, wrap: 0.76 },
  },
  pebble: {
    outline:
      "gJgDf9f2fufmfdfUfLfCe5eweneeeVeNeFd-d3dxdrdmdhdedadYdVdTdSdRdQdQdQdQdQdRdSdTdVdYdadedhdmdrdxd3d-eFeNeVeeenewe5fCfLfUfdfmfuf2f9gDgJgOgRgUgVgVgTgQgLgGf_f2fsfifWfKe-exeleZeNeCd5dwdpdidddZdVdTdRdQdQdQdRdTdVdZdddidpdwd5eCeNeZelexe-fKfWfifsf2f_gGgLgQgTgVgVgUgRgO",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.276, y: -0.123, scaleX: 0.912, scaleY: 0.948, front: 0.96 },
  },
  pumpkin: {
    outline:
      "gXgXgWgVgSgQgMgJgHgHgGf8fyfmfZfLe7eseceMd7dsdedPc_ctcXb8bibcbRbEaubEbRbcbib8cXctc_dPdedsd7eMecese7fLfZfmfyf8gGgHgHgJgMgQgSgVgWgXgXgWgVgQgKf_fyfgfKeweOdld_eMeTeVeUeQeJeBd2dpdadIc2ckcNbybYbRbHawZiawbHbRbYbycNckc2dIdadpd2eBeJeQeUeVeTeMd_dleOewfKfgfyf_gKgQgVgW",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.326, y: -0.12, scaleX: 1.053, scaleY: 1.003, front: 1 },
  },
  shield: {
    outline:
      "ZaZoZ6aPanbEbkcJczdheWfRgShcidjDjUjTjFiwiXh6hehCgogRf7fpfafNfFfAe-fAfFfNfafpf7gRgohCheh6iXiwjFjTjUjDidhcgSfReWdhczcJbkbEanaPZ6ZoZaZOZFY_Y7Y7Y8ZAZHZPZaZnZ2aHaZaubDbabxcJcic5dQdld5eKeZemeve2e7e9e-e9e7e2evemeZeKd5dldQc5cicJbxbabDauaZaHZ2ZnZaZPZHZAY8Y7Y7Y_ZFZO",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.215, y: -0.119, scaleX: 0.981, scaleY: 1.022, front: 0.74 },
  },
  sparkle: {
    outline:
      "h7gde-djcLa5ZtYmXmWsV3VmWZXRYPZUaebudEeff9hbi3kKlPmCmgmkmPljkijTh6gde-dicKa4ZrYlXlWrV2VmWaXSYQZUafbvdFegf-hbi3kKlPmDmgmjmOlikhjSh5gbe8dhcIa2ZqYkXjWqV1VlWYXQYPZTadbtdDedf7hZi0kIlOmBmemimNlikhjSh5gbe9dhcJa3ZrYlXlWqV1VkWXXQYOZSacbtdCedf7hZi1kIlPmDmfmkmPlikjjT",
    kind: { type: "slab", depth: 1, bevel: 0.3 },
    seat: { gap: 0.266, y: 0, scaleX: 0.911, scaleY: 0.911, front: 0.46 },
  },
  square: {
    outline:
      "bkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbmbkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbmbkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbmbkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbm",
    kind: { type: "slab", depth: 0.6, bevel: 0.18 },
    seat: { gap: 0.234, y: -0.106, scaleX: 0.866, scaleY: 0.866, front: 0.32 },
  },
  squircle: {
    outline:
      "e-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfAe-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfAe-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfAe-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfA",
    kind: { type: "slab", depth: 0.5, bevel: 0.075 },
    seat: { gap: 0.279, y: -0.119, scaleX: 0.912, scaleY: 0.912, front: 0.28 },
  },
  star: {
    outline:
      "YTYcY6Z1bWdOfciIkMlSlzl5likpi9gRd6b7aQZKYkYVYYYtZbaycjephLjok_lrl5lrk_johLepcjayZbYtYYYVYkZKaQb7d6gRi9kplil5lzlSkMiIfcdObWZ1Y6YcYTYcY6Z1bWdOfciIkMlSlzl5likpi-gSd6b7aQZKYkYVYYYtZcaycjephLjok_lrl5lrk_johLepcjayZcYtYYYVYkZKaQb7d6gSi-kplil5lzlSkMiIfcdObWZ1Y6Yc",
    kind: { type: "slab", depth: 0.8, bevel: 0.24 },
    seat: { gap: 0.266, y: -0.152, scaleX: 0.902, scaleY: 0.902, front: 0.38 },
  },
  tablet: {
    outline:
      "kykwkrkkkakMj7jojSi5idiAhgg-gZfzfMeid4dMcgbybFaaZ2ZXY9YnYWYJYAX6X4X6YAYJYWYnY9ZXZ2aabFbycgdMd4eifMfzgZg-hgiAidi5jSjoj7kMkakkkrkwkykwkrkkkakMj7jojSi5idiAhgg-gZfzfMeid4dMcgbybFaaZ2ZXY9YnYWYJYAX6X4X6YAYJYWYnY9ZXZ2aabFbycgdMd4eifMfzgZg-hgiAidi5jSjoj7kMkakkkrkw",
    kind: { type: "lathe", axis: "x", squeeze: 1 },
    seat: { gap: 0.347, y: -0.023, scaleX: 0.968, scaleY: 0.946, front: 0.74 },
  },
  teardrop: {
    outline:
      "czcicRcAbvbfbPa_awahaTaGZ9Z3Z2Z5Z_aKaZasbEbhcEcsdbeRfMgHg-hviXiwi5iwiXhvg-gHfMeRdbcscEbhbEasaZaKZ_Z4Z2Z3Z9aGaTahawa_bPbfbvcAcRciczdFdXdod6eMeeevfBfSfjf0gEgUgjgyhAhOhbhnhyh9iIiRiZihinitixi1i3i5i5i5i3i1ixitinihiZiRiIh9hyhnhbhOhAgygjgUgEf0fjfSfBeveeeMd6dodXdF",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.251, y: -0.2, scaleX: 0.891, scaleY: 0.893, wrap: 0.92 },
  },
  wedge: {
    outline:
      "ZxZFYfX_XkXNW6WrWgWZWUWUWXWdWnW1XGXcX1YSYxZUZ6aibMb4ckdOd2eYezfEfKfEezeYd2dOckb4bMaiZ6ZUYxYSX1XcXGW1WnWdWXWUWUWYWgWrW6XNXkX_YfZFZwajbccfdrfDgoiekcmboUp6rErprprJqRpLn9mtlekVjViehuhGgkgIfxfgfUfNfKfNfUfgfxgIgkhGhuiejVkVlemtn9pLqRrJrprprEp6oUmbkciegpfDdrcfbcaj",
    kind: { type: "lathe", axis: "y", squeeze: 1 },
    seat: { gap: 0.264, y: -0.206, scaleX: 0.911, scaleY: 0.945, front: 0.9 },
    gazeScale: 0.55,
  },
} as const satisfies Record<string, BotMarkBodySpec>;

export type BotMarkBodyShape = keyof typeof BOT_MARK_BODY_SPECS;
