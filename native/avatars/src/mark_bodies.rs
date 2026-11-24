//! Measured bodies for the bot mark, the same table as `packages/core/src/avatars/bot-mark-body-data.ts`
//! (written by the same local measurement; edit by re-measuring, not by hand).

use crate::mark::Shape;

pub(crate) enum Kind {
    Lathe { sideways: bool, squeeze: f32 },
    Slab { depth: f32, bevel: f32 },
}

pub(crate) enum Mount {
    Front(f32),
    Wrap(f32),
}

pub(crate) struct Seat {
    pub gap: f32,
    pub y: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub mount: Mount,
}

pub(crate) struct Spec {
    pub outline: &'static str,
    pub kind: Kind,
    pub seat: Seat,
    pub gaze_scale: f32,
}

/// The spec for a shaped body; the sphere has none.
pub(crate) fn spec(shape: Shape) -> Option<Spec> {
    Some(match shape {
        Shape::Arch => Spec {
            outline: "U1U3U7VEVPVeVxWIWjXCXlYJYrZNZvaPaubNbpcFcfc3dOdjd1eGeVeiese0e5e9e-e9e5e0eseieVeGd1djdOc3cfcFbpbNauaPZvZNYrYJXlXCWjWIVxVeVPVEU7U3U1U3U7VEVPVeVxWIWjXDXnYSZDZ8a8cHdde_griQjQjVi2iLhgg5gXf8flfUfIfBe-fBfIfUflf8gXg5hgiLi2jVjQiQgre_ddcHa8Z8ZDYSXnXDWjWIVxVeVPVEU7U3",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.216, y: 0.001, scale_x: 0.69, scale_y: 0.734, mount: Mount::Front(0.62) },
            gaze_scale: 1.,
        },
        Shape::Bean => Spec {
            outline: "XtXvXyXzX1X2X4X9YCYHYMYRYaYkYuY4ZFZSZhZyaDaWaqa_bTbrcGcfc2dMdmeBeZeufAfPfbfqf2f_gFgFgBf6fvfffLe1ead7dZczcKbea2aOZjY9YYX1XWW8WqWfWaWfWqW8XWX1YYY9ZjaOa2becKczdZd7eae1fLfffvf6gBgFgFf_f2fqfbfPfAeueZeBdmdMc2cfcGbrbTa_aqaWaDZyZhZSZFY4YuYkYaYRYMYHYCX9X4X2X1XzXyXv",
            kind: Kind::Lathe { sideways: false, squeeze: 0.9 },
            seat: Seat { gap: 0.222, y: -0.117, scale_x: 0.735, scale_y: 0.747, mount: Mount::Front(0.68) },
            gaze_scale: 1.,
        },
        Shape::Capsule => Spec {
            outline: "TvTwT1T9UIUWUoU9VXV1WYW_XoYPY2ZcaBakbFblcEcgc6dTdpd8eNecepeye4e8e-e8e4eyepeceNd8dpdTc6cgcEblbFakaBZcY2YPXoW_WYV1VXU9UoUWUIT9T1TwTvTwT1T9UIUWUoU9VXV1WYW_XoYPY2ZcaBakbFblcEcgc6dTdpd8eNecepeye4e8e-e8e4eyepeceNd8dpdTc6cgcEblbFakaBZcY2YPXoW_WYV1VXU9UoUWUIT9T1Tw",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.174, y: -0.119, scale_x: 0.768, scale_y: 0.803, mount: Mount::Front(0.6) },
            gaze_scale: 1.,
        },
        Shape::Cloud => Spec {
            outline: "h5hBgAe6dpdPdld_eVeme0e8fCfDfAe4erebeHdvdTczcObna7aNZbYnY5ZiaIatbQbycRcudIdfd0eHeWejeteze2e3e1evenebeOd8dodRc4ccb-bebXcud-fIgMhHh-itjVj4kTkpk3k-k_k5ktkakAjgi5iLhXgdfaeUdEbva4bBbVbmb2cDcPcZcfckcncnclchcbcScHb6brbZbFbFcDddeuf1g3hwijjPjykQklk0k8k8k2kokTj4jVir",
            kind: Kind::Slab { depth: 1.8, bevel: 0.9 },
            seat: Seat { gap: 0.268, y: -0.08, scale_x: 0.934, scale_y: 0.934, mount: Mount::Front(0.82) },
            gaze_scale: 1.,
        },
        Shape::Clover => Spec {
            outline: "YjZkajbdcVdId4ejfLftgMgmg8hMhYhfhihfhYhMg8gmgMftfLejd4dIcVbdajZkYjZkajbdcVdId4ejfLftgMgmg8hMhYhfhhhfhYhMg8gmgMftfLejd4dIcVbdajZkYjZkajbdcVdId4ejfLftgMgmg8hMhYhfhihfhYhMg8gmgMftfLejd4dIcVbdajZkYjZkajbdcVdId4ejfLftgMgmg8hMhYhfhihfhYhMg8gmgMftfLejd4dIcVbdajZk",
            kind: Kind::Slab { depth: 0.7, bevel: 0.21 },
            seat: Seat { gap: 0.258, y: 0.018, scale_x: 0.826, scale_y: 0.826, mount: Mount::Front(0.34) },
            gaze_scale: 1.,
        },
        Shape::Crystal => Spec {
            outline: "XTXUXaXjXwYBYWYvZNZxaabKcBdAeCeue-fBfJfWfogAgdhAhqiajTkUlfm1oYp2qap2oYm1lfkUjTiahqhAgdgAfofWfJfBe-eueCdAcBbKaaZxZNYvYWYBXwXjXaXUXTXUXaXjXwYBYWYvZNZxaabKcBdAeCeue-fBfJfWfogAgdhAhqiajTkUlfm1oYp2qap2oYm1lfkUjTiahqhAgdgAfofWfJfBe-eueCdAcBbKaaZxZNYvYWYBXwXjXaXU",
            kind: Kind::Lathe { sideways: false, squeeze: 0.9 },
            seat: Seat { gap: 0.221, y: -0.14, scale_x: 0.765, scale_y: 0.725, mount: Mount::Wrap(0.68) },
            gaze_scale: 1.,
        },
        Shape::Cylinder => Spec {
            outline: "aeagamaxa_bSbqcHcqdSeBe3f0gnhEhThXhThLhAgygjgUgGf4frfgfWfNfHfCe_e-e_fCfHfNfWfgfrf4gGgUgjgyhAhLhThXhThEgnf0e3eBdScqcHbqbSa_axamagaeagamaxa_bSbqcHcqdSeBe3f0gnhEhShXhThLhAgygjgUgGf4frfgfWfNfHfCe_e-e_fCfHfNfWfgfrf4gGgUgjgyhAhLhThXhShEgnf0e3eBdScqcHbqbSa_axamag",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.235, y: -0.119, scale_x: 0.909, scale_y: 0.912, mount: Mount::Wrap(0.84) },
            gaze_scale: 1.,
        },
        Shape::Dome => Spec {
            outline: "cQbxbTa3adaEZuZYZEYyYhYRYCX1XpXeXTXKXBW6WzWtWnWiWeWaWYWVWSWRWQWPWPWPWQWRWSWVWYWaWeWiWnWtWzW6XBXKXTXeXpX1YCYRYhYyZEZYZuaEada3bTbxcQcydWd7ejfNf6gohZiMjDj-kwkki-hGfceAcxbsavZ7ZNYmYEXnXPW7WrWeWWWRWPWRWWWeWrW7XPXnYEYmZNZ7avbscxeAfchGi-kkkwj-jDiMhZgof6fNejd7dWcy",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.234, y: -0.105, scale_x: 0.788, scale_y: 0.813, mount: Mount::Front(0.9) },
            gaze_scale: 1.,
        },
        Shape::Egg => Spec {
            outline: "ZYZRZLZHZDZBZAZAZDZGZLZRZaZkZvZ8aLacaubCbXbucGcec4dRdpeAeUemeze7e-e7ezemeUeAdpdRc4cecGbubXbCauacaLZ8ZvZkZaZRZLZGZDZAZAZBZDZHZLZRZYZgZqZ0Z-aKaWajawa-bMbbbqb5cIcWcmc0dDdRdfdsd4eFePeaejerexe3e7e9e-e9e7e3exerejeaePeFd4dsdfdRdDc0cmcWcIb5bqbbbMa-awajaWaKZ-Z0ZqZg",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.213, y: -0.112, scale_x: 0.909, scale_y: 0.912, mount: Mount::Wrap(0.8) },
            gaze_scale: 1.,
        },
        Shape::Flower => Spec {
            outline: "YVaRb2dLeSfOf_glhDhXhhhihbhKgwgNfgendkcUa0ZAZqbXcxd8e7fvgZg6hRhfhkhfhRg6gZfve7d8cxbXZqZAa0cUdkenfggNgwhKhbhihhhXhDglf_fOeSdLb2aRYVaRb2dLeSfOf_glhDhXhhhihbhKgwgNfgendkcUa0ZAZqbXcxd8e7fvgZg6hRhfhkhfhRg6gZfve7d8cxbXZqZAa0cUdkenfggNgwhKhbhihhhXhDglf_fOeSdLb2aR",
            kind: Kind::Slab { depth: 0.9, bevel: 0.27 },
            seat: Seat { gap: 0.226, y: -0.141, scale_x: 0.875, scale_y: 0.876, mount: Mount::Front(0.42) },
            gaze_scale: 1.,
        },
        Shape::Gem => Spec {
            outline: "eqeheOd6dmdRc-cscccNcAb2bsbmbhbebebfbjbpbxb7cHcVclc3dKdfd0eKefeye-eyefeKd0dfdKc3clcVcHb7bxbpbjbfbebebhbmbsb2cAcNcccsc-dRdmd6eOeheqeheOd7dmdRc-cscccNcAb2btbmbhbebebfbjbpbxb7cHcVclc3dKdfd0eKefeye-eyefeKd0dfdKc3clcVcHb7bxbpbjbfbebebhbmbtb2cAcNcccsc-dRdmd7eOeh",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.244, y: -0.119, scale_x: 0.882, scale_y: 0.912, mount: Mount::Front(0.9) },
            gaze_scale: 1.,
        },
        Shape::Heart => Spec {
            outline: "hhiPi4jej-kZkwlClOlWlZlWlPlDk0kfkHjsjNiriFhdgzgGfWeldzdAcKbTacZkY2ZlacbTcKc_d0emfWgFgyheiFiqjNjskIkfkzlElPlWlYlWlOlCkxkaj-jei4iOhhguf4e_eCdFcPbga3aUZ2ZeZJY6YuYmYiYiYlYtY4ZHZbZzaQaybXb4cTcmc1c9dAc-c1cmcSb4bYayaQZzZbZHY4YtYlYhYiYmYuY5ZJZeZ2aUa3bfcOdFeCe_f4gu",
            kind: Kind::Slab { depth: 1.4, bevel: 0.7 },
            seat: Seat { gap: 0.257, y: -0.06, scale_x: 0.825, scale_y: 0.825, mount: Mount::Front(0.7) },
            gaze_scale: 0.6,
        },
        Shape::Hex => Spec {
            outline: "eBeDeKeWene9fYf4gcg2hFhIg8glgFfifFetebeOeFeBeCeHeRege0fOftgQgvhChIhCgvgQftfOe1eheSeHeCeBeFeOebetfFfigFglg8hIhFg2gcf4fYe9eneWeKeDeBeDeKeWene9fYf4gcg2hFhIg8glgFfifFetebeOeFeBeCeHeSehe1fOftgQgvhChIhCgvgQftfOe1eheSeIeCeBeFeOebetfFfigFglg8hIhFg2gcf4fYe9eneWeKeD",
            kind: Kind::Slab { depth: 0.8, bevel: 0.24 },
            seat: Seat { gap: 0.34, y: -0.127, scale_x: 1.061, scale_y: 1.061, mount: Mount::Front(0.38) },
            gaze_scale: 1.,
        },
        Shape::House => Spec {
            outline: "dWdZdedkdmdldhdZdMc8cocSb5bgbKa5asakagagakasa5bKbfb6cZc_dneKeme4e_e4emeKdnc_cZb6bfbKa5atakagagakata5bKbgb5cScoc8dMdZdhdldmdjdedZdWdZdgdrd7eRerfLfxgehSiOjTkjl3m6ninpnOmZlQkHjIiRhig5gXf8flfUfIfBe-fBfIfUflf8gXg5hiiRjIkHlQmZnOnpnim6l3kjjTiOhSgefxfLereRd7drdgdZ",
            kind: Kind::Slab { depth: 0.7, bevel: 0.21 },
            seat: Seat { gap: 0.254, y: -0.182, scale_x: 0.875, scale_y: 0.875, mount: Mount::Front(0.36) },
            gaze_scale: 1.,
        },
        Shape::Leaf => Spec {
            outline: "YHYHYIYJYKYMYOYRYUYYYdYiYpYwY5ZDZOZaZoZ3aIaaaubEbcb2cRctdMdreKeoe-eoeKdrdMctcRb2bcbEauaaaIZ3ZoZaZOZDY5YwYpYiYdYYYUYRYOYMYKYJYIYHYHYHYIYJYKYMYOYRYUYYYdYiYpYwY5ZDZOZaZoZ3aIaaaubEbcb2cRcudMdreKeoe-eoeKdrdMcucRb2bcbEauaaaIZ3ZoZaZOZDY5YwYpYiYdYYYUYRYOYMYKYJYIYH",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.221, y: -0.04, scale_x: 0.713, scale_y: 0.714, mount: Mount::Wrap(0.76) },
            gaze_scale: 1.,
        },
        Shape::Pebble => Spec {
            outline: "gJgDf9f2fufmfdfUfLfCe5eweneeeVeNeFd-d3dxdrdmdhdedadYdVdTdSdRdQdQdQdQdQdRdSdTdVdYdadedhdmdrdxd3d-eFeNeVeeenewe5fCfLfUfdfmfuf2f9gDgJgOgRgUgVgVgTgQgLgGf_f2fsfifWfKe-exeleZeNeCd5dwdpdidddZdVdTdRdQdQdQdRdTdVdZdddidpdwd5eCeNeZelexe-fKfWfifsf2f_gGgLgQgTgVgVgUgRgO",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.276, y: -0.123, scale_x: 0.912, scale_y: 0.948, mount: Mount::Front(0.96) },
            gaze_scale: 1.,
        },
        Shape::Pumpkin => Spec {
            outline: "gXgXgWgVgSgQgMgJgHgHgGf8fyfmfZfLe7eseceMd7dsdedPc_ctcXb8bibcbRbEaubEbRbcbib8cXctc_dPdedsd7eMecese7fLfZfmfyf8gGgHgHgJgMgQgSgVgWgXgXgWgVgQgKf_fyfgfKeweOdld_eMeTeVeUeQeJeBd2dpdadIc2ckcNbybYbRbHawZiawbHbRbYbycNckc2dIdadpd2eBeJeQeUeVeTeMd_dleOewfKfgfyf_gKgQgVgW",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.326, y: -0.12, scale_x: 1.053, scale_y: 1.003, mount: Mount::Front(1.) },
            gaze_scale: 1.,
        },
        Shape::Shield => Spec {
            outline: "ZaZoZ6aPanbEbkcJczdheWfRgShcidjDjUjTjFiwiXh6hehCgogRf7fpfafNfFfAe-fAfFfNfafpf7gRgohCheh6iXiwjFjTjUjDidhcgSfReWdhczcJbkbEanaPZ6ZoZaZOZFY_Y7Y7Y8ZAZHZPZaZnZ2aHaZaubDbabxcJcic5dQdld5eKeZemeve2e7e9e-e9e7e2evemeZeKd5dldQc5cicJbxbabDauaZaHZ2ZnZaZPZHZAY8Y7Y7Y_ZFZO",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.215, y: -0.119, scale_x: 0.981, scale_y: 1.022, mount: Mount::Front(0.74) },
            gaze_scale: 1.,
        },
        Shape::Sparkle => Spec {
            outline: "h7gde-djcLa5ZtYmXmWsV3VmWZXRYPZUaebudEeff9hbi3kKlPmCmgmkmPljkijTh6gde-dicKa4ZrYlXlWrV2VmWaXSYQZUafbvdFegf-hbi3kKlPmDmgmjmOlikhjSh5gbe8dhcIa2ZqYkXjWqV1VlWYXQYPZTadbtdDedf7hZi0kIlOmBmemimNlikhjSh5gbe9dhcJa3ZrYlXlWqV1VkWXXQYOZSacbtdCedf7hZi1kIlPmDmfmkmPlikjjT",
            kind: Kind::Slab { depth: 1., bevel: 0.3 },
            seat: Seat { gap: 0.266, y: 0., scale_x: 0.911, scale_y: 0.911, mount: Mount::Front(0.46) },
            gaze_scale: 1.,
        },
        Shape::Square => Spec {
            outline: "bkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbmbkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbmbkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbmbkbmbtb4cHcbc0dSd2egfQgJhKiUjakKkbkKjaiUhKgJfQegd2dSc0cbcHb4btbm",
            kind: Kind::Slab { depth: 0.6, bevel: 0.18 },
            seat: Seat { gap: 0.234, y: -0.106, scale_x: 0.866, scale_y: 0.866, mount: Mount::Front(0.32) },
            gaze_scale: 1.,
        },
        Shape::Squircle => Spec {
            outline: "e-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfAe-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfAe-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfAe-fAfHfSfif0gJggg7hVhviJihizjCjMjRjMjCizihiJhvhVg7gggJf0fifSfHfA",
            kind: Kind::Slab { depth: 0.5, bevel: 0.075 },
            seat: Seat { gap: 0.279, y: -0.119, scale_x: 0.912, scale_y: 0.912, mount: Mount::Front(0.28) },
            gaze_scale: 1.,
        },
        Shape::Star => Spec {
            outline: "YTYcY6Z1bWdOfciIkMlSlzl5likpi9gRd6b7aQZKYkYVYYYtZbaycjephLjok_lrl5lrk_johLepcjayZbYtYYYVYkZKaQb7d6gRi9kplil5lzlSkMiIfcdObWZ1Y6YcYTYcY6Z1bWdOfciIkMlSlzl5likpi-gSd6b7aQZKYkYVYYYtZcaycjephLjok_lrl5lrk_johLepcjayZcYtYYYVYkZKaQb7d6gSi-kplil5lzlSkMiIfcdObWZ1Y6Yc",
            kind: Kind::Slab { depth: 0.8, bevel: 0.24 },
            seat: Seat { gap: 0.266, y: -0.152, scale_x: 0.902, scale_y: 0.902, mount: Mount::Front(0.38) },
            gaze_scale: 1.,
        },
        Shape::Tablet => Spec {
            outline: "kykwkrkkkakMj7jojSi5idiAhgg-gZfzfMeid4dMcgbybFaaZ2ZXY9YnYWYJYAX6X4X6YAYJYWYnY9ZXZ2aabFbycgdMd4eifMfzgZg-hgiAidi5jSjoj7kMkakkkrkwkykwkrkkkakMj7jojSi5idiAhgg-gZfzfMeid4dMcgbybFaaZ2ZXY9YnYWYJYAX6X4X6YAYJYWYnY9ZXZ2aabFbycgdMd4eifMfzgZg-hgiAidi5jSjoj7kMkakkkrkw",
            kind: Kind::Lathe { sideways: true, squeeze: 1. },
            seat: Seat { gap: 0.347, y: -0.023, scale_x: 0.968, scale_y: 0.946, mount: Mount::Front(0.74) },
            gaze_scale: 1.,
        },
        Shape::Teardrop => Spec {
            outline: "czcicRcAbvbfbPa_awahaTaGZ9Z3Z2Z5Z_aKaZasbEbhcEcsdbeRfMgHg-hviXiwi5iwiXhvg-gHfMeRdbcscEbhbEasaZaKZ_Z4Z2Z3Z9aGaTahawa_bPbfbvcAcRciczdFdXdod6eMeeevfBfSfjf0gEgUgjgyhAhOhbhnhyh9iIiRiZihinitixi1i3i5i5i5i3i1ixitinihiZiRiIh9hyhnhbhOhAgygjgUgEf0fjfSfBeveeeMd6dodXdF",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.251, y: -0.2, scale_x: 0.891, scale_y: 0.893, mount: Mount::Wrap(0.92) },
            gaze_scale: 1.,
        },
        Shape::Wedge => Spec {
            outline: "ZxZFYfX_XkXNW6WrWgWZWUWUWXWdWnW1XGXcX1YSYxZUZ6aibMb4ckdOd2eYezfEfKfEezeYd2dOckb4bMaiZ6ZUYxYSX1XcXGW1WnWdWXWUWUWYWgWrW6XNXkX_YfZFZwajbccfdrfDgoiekcmboUp6rErprprJqRpLn9mtlekVjViehuhGgkgIfxfgfUfNfKfNfUfgfxgIgkhGhuiejVkVlemtn9pLqRrJrprprEp6oUmbkciegpfDdrcfbcaj",
            kind: Kind::Lathe { sideways: false, squeeze: 1. },
            seat: Seat { gap: 0.264, y: -0.206, scale_x: 0.911, scale_y: 0.945, mount: Mount::Front(0.9) },
            gaze_scale: 0.55,
        },
        Shape::Circle | Shape::Blob => return None,
    })
}
