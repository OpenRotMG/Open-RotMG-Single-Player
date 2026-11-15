use super::*;

/// Electron's profile and the server's keys and logs live in server data, so player data holds only saves.
pub(super) fn prepare(root: &Path) -> Result<PathBuf, String> {
    for directory in [root.join("player data"), root.join("server data")] {
        if !fs::symlink_metadata(&directory).map_err(|e| e.to_string())?.is_dir() || directory.portable_canonicalize().map_err(|e| e.to_string())? != directory {
            return Err(format!("Storage must be an ordinary local directory: {}", directory.display()));
        }
    }
    owned_directory(root.join("server data").join("profile"))
}

pub(super) fn server(root: &Path) -> Result<PathBuf, String> {
    owned_directory(prepare(root)?.join("server-state"))
}

fn owned_directory(path: PathBuf) -> Result<PathBuf, String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    if path.portable_canonicalize().map_err(|e| e.to_string())? != path {return Err(format!("Storage must not be linked: {}", path.display()))}
    Ok(path)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn storage_is_created_inside_server_data_and_repeatable() {
        let fixture = crate::tests::fixture();
        let root = fixture.portable_canonicalize().unwrap();
        if fixture != root {assert!(prepare(&fixture).is_err());}
        let profile = prepare(&root).unwrap();
        assert_eq!(profile, root.join("server data").join("profile"));
        assert_eq!(prepare(&root).unwrap(), profile);
        assert_eq!(server(&root).unwrap(), profile.join("server-state"));
        fs::remove_dir_all(root).unwrap();
    }
}
