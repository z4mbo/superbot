use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::sync::mpsc;

use gpui_kit::App;

pub(crate) fn headless(test: impl FnOnce(&mut App) + 'static) {
    let (done, outcome) = mpsc::channel();
    gpui_kit::platform::headless().run(move |cx| {
        let result = catch_unwind(AssertUnwindSafe(|| test(cx)));
        cx.spawn(async move |cx| cx.update(|cx| cx.quit())).detach();
        done.send(result).expect("receive test outcome");
    });
    if let Err(panic) = outcome.recv().expect("run headless app") {
        resume_unwind(panic);
    }
}
