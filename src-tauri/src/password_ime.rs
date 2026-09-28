//! Temporarily close the Windows IME while a password input owns focus.
//! WebView CSS/inputmode does not reliably switch Microsoft Pinyin to Latin.

#[cfg(windows)]
mod windows_ime {
    use std::sync::Mutex;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::Ime::{
        ImmGetContext, ImmGetOpenStatus, ImmReleaseContext, ImmSetOpenStatus,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;

    static PREVIOUS: Mutex<Option<(usize, bool)>> = Mutex::new(None);

    unsafe fn restore(hwnd_value: usize, was_open: bool) {
        let hwnd = HWND(hwnd_value as *mut _);
        let context = ImmGetContext(hwnd);
        if !context.is_invalid() {
            let _ = ImmSetOpenStatus(context, was_open);
            let _ = ImmReleaseContext(hwnd, context);
        }
    }

    /// Must run on the window thread: GetFocus is scoped to the calling thread.
    pub fn set_active(active: bool) -> Result<(), &'static str> {
        let mut previous = PREVIOUS.lock().map_err(|_| "IME state unavailable")?;
        if !active {
            if let Some((hwnd, was_open)) = previous.take() {
                // SAFETY: the saved HWND is only used on this UI thread.
                unsafe { restore(hwnd, was_open) };
            }
            return Ok(());
        }

        // SAFETY: GetFocus and IMM calls run on Tauri's window thread.
        unsafe {
            let hwnd = GetFocus();
            if hwnd.is_invalid() {
                return Err("No focused Windows input window");
            }
            let hwnd_value = hwnd.0 as usize;
            if previous
                .as_ref()
                .is_some_and(|(saved, _)| *saved != hwnd_value)
            {
                if let Some((saved, was_open)) = previous.take() {
                    restore(saved, was_open);
                }
            }
            let context = ImmGetContext(hwnd);
            if context.is_invalid() {
                return Err("The focused window has no IME context");
            }
            if previous.is_none() {
                *previous = Some((hwnd_value, ImmGetOpenStatus(context).as_bool()));
            }
            let changed = ImmSetOpenStatus(context, false).as_bool();
            let _ = ImmReleaseContext(hwnd, context);
            if !changed {
                return Err("Windows rejected the IME mode change");
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn set_password_ime(active: bool, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(windows_ime::set_active(active));
        })
        .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|error| error.to_string())?
            .map_err(str::to_string)
    }
    #[cfg(not(windows))]
    {
        let _ = (active, app);
        Ok(())
    }
}
