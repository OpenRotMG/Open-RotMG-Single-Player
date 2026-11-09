// The portable ZIP keeps Electron's many sibling files in "server data"; this program is the one thing to open.
#![windows_subsystem = "windows"]
use std::{env, ffi::OsString, process::Command};

fn fail(message: String) -> ! {
    eprintln!("OpenRotMG Singleplayer: {message}");
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(window: *mut u8, text: *const u16, caption: *const u16, kind: u32) -> i32;
        }
        let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
        unsafe { MessageBoxW(std::ptr::null_mut(), wide(&message).as_ptr(), wide("OpenRotMG Singleplayer").as_ptr(), 0x10) };
    }
    std::process::exit(1);
}

fn main() {
    let program = env::current_exe().unwrap_or_else(|error| fail(format!("Cannot locate this program: {error}")));
    let root = program.parent().unwrap_or_else(|| fail(format!("No folder contains {}", program.display())));
    let player = root.join("player data");
    let game = root.join("server data").join(if cfg!(target_os = "macos") {
        "Open RotMG Single Player.app/Contents/MacOS/openrotmg-single-player"
    } else if cfg!(windows) {
        "openrotmg-single-player.exe"
    } else {
        "openrotmg-single-player"
    });
    for path in [&player, &game] {
        if !path.exists() {
            fail(format!("Missing {}\nKeep this program next to the \"player data\" and \"server data\" folders from the ZIP.", path.display()));
        }
    }
    let mut profile = OsString::from("--user-data-dir=");
    profile.push(&player);
    let mut command = Command::new(&game);
    command.arg(profile).args(env::args_os().skip(1));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        fail(format!("Cannot start {}: {error}", game.display()));
    }
    #[cfg(windows)]
    match command.status() {
        Ok(status) => std::process::exit(status.code().expect("Windows exit statuses always carry a code")),
        Err(error) => fail(format!("Cannot start {}: {error}", game.display())),
    }
}
