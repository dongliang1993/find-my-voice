// The desktop shell. One job at a time: open the local web app.
// The server sidecar is NOT managed here yet — see scripts/spike/README.md
// for the open questions before this becomes the real launcher.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    find_my_voice_lib::run()
}
