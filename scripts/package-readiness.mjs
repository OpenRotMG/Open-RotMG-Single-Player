export function packagedChildReady(view) {
  if(view.status==='failed'||(view.status==='stopped'&&view.message.startsWith('Cannot start:')))throw Error(`Packaged child startup failed: ${view.message}\n${view.logs.join('\n')}`);
  return view.status==='ready';
}
