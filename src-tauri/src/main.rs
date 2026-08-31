// Windows release builds open no console window; a desktop assistant that
// spawns a terminal behind itself looks broken even when it is not.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    helix_lib::run()
}
