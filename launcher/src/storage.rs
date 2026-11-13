use super::*;

pub(super) fn prepare(root: &Path) -> Result<PathBuf, String> {
    let player = root.join("player data");
    let server = root.join("server data");
    let profile = server.join("profile");
    for directory in [&player, &server] {
        if !fs::symlink_metadata(directory).map_err(|e| e.to_string())?.is_dir() || directory.portable_canonicalize().map_err(|e| e.to_string())? != *directory {
            return Err(format!("Storage must be an ordinary local directory: {}", directory.display()));
        }
    }
    let state = player.join("state");
    let _state_owner = if state.exists() {
        if !fs::symlink_metadata(&state).map_err(|e|e.to_string())?.is_dir() || state.portable_canonicalize().map_err(|e|e.to_string())? != state {return Err("Save state directory must not be linked".into())}
        let lock_path=state.join("state.lock");
        match fs::symlink_metadata(&lock_path){Ok(info) if !info.is_file()=>return Err("Save lock must be a regular unlinked file".into()),Err(error) if error.kind()!=std::io::ErrorKind::NotFound=>return Err(error.to_string()),_=>{}}
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(state.join("state.lock")).map_err(|e| e.to_string())?;
        file.try_lock_exclusive().map_err(|e| format!("Stop the game before moving launcher storage: {e}"))?;
        Some(file)
    } else { None };
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    if profile.portable_canonicalize().map_err(|e| e.to_string())? != profile {return Err("Launcher profile must not be linked".into())}
    for entry in fs::read_dir(&player).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name(); let name = name.to_str().ok_or("Storage name is not UTF8")?;
        // User exports and snapshots stay with saves; Chromium databases and runtime control files do not.
        let save = ["state", "backups"].contains(&name) || ((name.ends_with(".json") && !name.starts_with("runtime-") && !["desktop-config.json", "shutdown-failed.json"].contains(&name)) || name.ends_with(".sqlite") || name.ends_with(".db") && !name.starts_with("declarative_"));
        if save {continue}
        let destination = profile.join(name);
        if fs::symlink_metadata(&destination).is_ok() {return Err(format!("Both old and new storage contain {name}. Keep both folders; resolve this conflict before opening the game."))}
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {return Err(format!("Refusing linked legacy launcher storage: {name}"))}
        durable_move(&entry.path(), &destination, false)?;
    }
    sync_dir(&player)?; sync_dir(&profile)?; sync_dir(&server)?;
    Ok(profile)
}

pub(super) fn server(root:&Path)->Result<PathBuf,String>{
    let profile=prepare(root)?;let state=root.join("player data/state");fs::create_dir_all(&state).map_err(|e|e.to_string())?;
    if state.portable_canonicalize().map_err(|e|e.to_string())?!=state{return Err("Save state must not be linked".into())}
    let owner=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(state.join("state.lock")).map_err(|e|e.to_string())?;owner.try_lock_exclusive().map_err(|e|format!("Stop the server before moving operational files: {e}"))?;
    let destination=profile.join("server-state");fs::create_dir_all(&destination).map_err(|e|e.to_string())?;if destination.portable_canonicalize().map_err(|e|e.to_string())?!=destination{return Err("Server state must not be linked".into())}
    for name in ["server.pem","lag","bug-reports","last-critical-incident.json"]{let source=state.join(name);match fs::symlink_metadata(&source){Err(e)if e.kind()==std::io::ErrorKind::NotFound=>continue,Err(e)=>return Err(e.to_string()),Ok(info)if info.file_type().is_symlink()=>return Err(format!("Refusing linked server state: {name}")),_=>{}}let target=destination.join(name);if fs::symlink_metadata(&target).is_ok(){return Err(format!("Both save and operational folders contain {name}; keep both and report this conflict."))}durable_move(&source,&target,false)?;}
    sync_dir(&state)?;sync_dir(&destination)?;Ok(destination)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn migration_keeps_save_and_lock_inodes_and_is_repeatable() {
        let fixture = crate::tests::fixture();
        let root = fixture.portable_canonicalize().unwrap();
        if fixture != root {assert!(prepare(&fixture).is_err());}
        fs::create_dir(root.join("player data/state")).unwrap();
        fs::write(root.join("player data/state/game.db"), b"save").unwrap();
        fs::write(root.join("player data/runtime-selection.json"), b"selection").unwrap();
        fs::create_dir(root.join("player data/Cache")).unwrap();
        let profile = prepare(&root).unwrap();
        assert_eq!(fs::read(root.join("player data/state/game.db")).unwrap(), b"save");
        assert_eq!(fs::read(profile.join("runtime-selection.json")).unwrap(), b"selection");
        assert!(profile.join("Cache").is_dir());
        assert_eq!(prepare(&root).unwrap(), profile);
        let held=OpenOptions::new().read(true).write(true).open(root.join("player data/state/state.lock")).unwrap();held.try_lock_exclusive().unwrap();assert!(prepare(&root).is_err());drop(held);
        fs::write(root.join("player data/runtime-selection.json"), b"conflict").unwrap();assert!(prepare(&root).is_err());assert_eq!(fs::read(root.join("player data/runtime-selection.json")).unwrap(),b"conflict");
        fs::remove_file(root.join("player data/runtime-selection.json")).unwrap();
        fs::write(root.join("player data/state/server.pem"),b"owned key bytes").unwrap();let operational=server(&root).unwrap();assert_eq!(fs::read(operational.join("server.pem")).unwrap(),b"owned key bytes");assert!(!root.join("player data/state/server.pem").exists());assert_eq!(server(&root).unwrap(),operational);
        fs::remove_dir_all(root).unwrap();
    }
}
