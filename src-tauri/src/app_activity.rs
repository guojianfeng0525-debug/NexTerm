//! Keep the process out of macOS App Nap while remote sessions are open.
//!
//! App Nap freezes *all* of a hidden app's timers — including the tokio
//! runtime that drives the SSH keepalive (russh `keepalive_interval`) and the
//! WebSocket heartbeat. With the process napped, an idle-but-healthy session
//! sends no traffic for as long as the window stays hidden, so servers with
//! `ClientAliveInterval` (or NAT middleboxes) tear the TCP connection down and
//! the user sees a surprise reconnect on return — the classic "keepalive was
//! configured but never fired" report. Holding a user-initiated activity for
//! the lifetime of every remote connection is the standard terminal-app
//! remedy (iTerm2 and friends do the same).
//!
//! `UserInitiatedAllowingIdleSystemSleep` prevents App Nap *without* blocking
//! system sleep: closing the lid may still kill the network path, which the
//! frontend's reconnect flow handles legitimately.

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// Opaque NSProcessInfoActivity handle. Apple documents activity
    /// begin/end as callable from any thread, so the objc2 type's missing
    /// Send/Sync is a blanket-protocol limitation, not a real constraint.
    struct ActivityToken(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    unsafe impl Send for ActivityToken {}
    unsafe impl Sync for ActivityToken {}

    static ACTIVITY: Mutex<Option<ActivityToken>> = Mutex::new(None);

    pub fn acquire() {
        let mut activity = ACTIVITY.lock().unwrap();
        if activity.is_some() {
            return;
        }
        let reason = NSString::from_str("NexTerm remote sessions active");
        let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &reason,
        );
        tracing::debug!("[app-activity] App Nap disabled while sessions are open");
        *activity = Some(ActivityToken(token));
    }

    pub fn release() {
        let token = ACTIVITY.lock().unwrap().take();
        let Some(token) = token else {
            return;
        };
        let process_info = NSProcessInfo::processInfo();
        // The token came from our own beginActivity call and is ended exactly once.
        unsafe { process_info.endActivity(&token.0) };
        tracing::debug!("[app-activity] App Nap guard released");
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn acquire() {}
    pub fn release() {}
}

pub use imp::{acquire, release};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn activity_is_acquired_once_and_released_once() {
        acquire(); // already held by an earlier test? both paths must be no-op safe
        acquire();
        release();
        release();
        acquire();
        release();
    }
}
