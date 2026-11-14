import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
export const desktopName='org.openrotmg.singleplayer.desktop';
export async function installDesktopIcon(dataHome:string,launcher:string,icon:string){
 if(!isAbsolute(dataHome)||!isAbsolute(launcher)||!isAbsolute(icon)||/[\r\n\0]/.test(launcher))throw Error('Invalid launcher desktop integration paths');
 const icons=join(dataHome,'icons/hicolor/256x256/apps'),applications=join(dataHome,'applications');await mkdir(icons,{recursive:true});await mkdir(applications,{recursive:true});await writeFile(join(icons,'org.openrotmg.singleplayer.png'),await readFile(icon));
 const command=launcher.replace(/[%]/g,'%%').replace(/[\\"`$]/g,'\\$&').replaceAll('\\','\\\\');
 // Wayland resolves the taskbar icon through the matching app_id and desktop filename.
 await writeFile(join(applications,desktopName),`[Desktop Entry]\nType=Application\nName=Open RotMG Single Player\nExec="${command}"\nIcon=org.openrotmg.singleplayer\nTerminal=false\nCategories=Game;\n`,{mode:0o644});
}
