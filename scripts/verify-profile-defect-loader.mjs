import { registerHooks } from 'node:module'
const variant = process.env.TIANSHU_PROFILE_DEFECT
let applied = false
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context)
  if (!result.source) return result
  const source = result.source.toString()
  let changed = source
  if (url.includes('/server/account-routes.') && variant === 'approval-wait') changed = source.replace(/void refreshAccount\(store,saved\.accessToken,true\)/, 'await refreshAccount(store,saved.accessToken,true)')
  if (url.includes('/server/account-routes.') && variant === 'overwrite') changed = source.replace(/api\.saveAccountProfile\(store,fresh,\{/g, 'api.saveAccountProfile(store,{accessToken,expiresAt:Date.now()+3600000},{')
  if (url.includes('/server/account-routes.') && variant === 'late-approval') changed = source.replace(/if\(started!==generation\)return\{status:200,body:\{status:"expired"\}\};/, '')
  if (url.includes('/server/account-routes.') && variant === 'receipt') changed = source.replace(/if\(previous\)return previous\.promise;/, '')
  if (url.includes('/server/account-routes.') && variant === 'status-wait') changed = source.replace(/void refreshAccount\(store,token\.accessToken\)/, 'await refreshAccount(store,token.accessToken)')
  if (url.includes('/server/account-routes.') && variant === 'refresh-dedupe') changed = source.replace(/if\(refreshJob\?\.accessToken===accessToken\)return refreshJob\.promise;/, '')
  if (url.includes('/auth/account.') && variant === 'url') changed = source.replace(/url\.searchParams\.set\("code",userCode\)/, 'url.searchParams.append("code",userCode)')
  if (url.includes('/lib/account-login-session.') && variant === 'unmount') changed = source.replace(/listeners\.delete\(listener\)/, 'listeners.delete(listener);cancel()')
  if (url.includes('/lib/account-login-session.') && variant === 'retry-budget') changed = source.replace(/failures=result\?0:failures\+1;/, 'failures=result?0:failures+1;if(failures>=3){update({phase:"error"});return}')
  if (url.includes('/lib/account-login-session.') && variant === 'late-ui') changed = source.replace(/if\(attempt!==generation\)return;/g, '')
  if (url.includes('/auth/account.') && variant === 'device-profile') changed = source.replace(/const raw=res\?\.ok\?[^;]+:null;/, 'if(!res?.ok)return null;const raw=await res.json();')
  if (url.includes('/auth/account.') && variant === 'empty-profile') changed = source.replace(/if\(avatarUrl===null&&founding===null&&\([^;]+?\)\)return null;/, 'if(avatarUrl===null&&founding===null)return null;')
  if (url.includes('/server/account-routes.') && variant === 'device-renewal') changed = source.replace(/before.expiresAt<=Date.now\(\)\+(?:6e4|60000)&&before.refreshToken&&api.refreshAccountToken/, 'false&&before.refreshToken&&api.refreshAccountToken')
  if (url.includes('/server/account-routes.') && variant === 'badge-retry') changed = source.replace(/!previous\?\.unconfirmed\?\.length&&/, '')
  if (url.includes('/server/account-routes.') && variant === 'late-renewal') changed = source.replace(/const fresh=current\(\);if\(!rotated\?\.accessToken\|\|!fresh\)/, 'const fresh=store.load();if(!rotated?.accessToken||!fresh)')
  if (url.includes('/server/account-routes.') && variant === 'rotation-response') changed = source.replace(/fresh\?\.accessToken!==token.accessToken&&!renewed/, 'fresh?.accessToken!==token.accessToken')
  if (url.includes('/surfaces/ProfileSurface.') && variant === 'local-identity') changed = source.replace(/profile:signedIn&&status\?\.displayName\?\{name:null,avatar:null\}:profile/, 'profile')
  if (url.includes('/server/profile-library-routes.') && variant === 'presence-gap') changed = source.replace(/previous\?\.owner===owner&&elapsed>=0&&elapsed<=45e3/, 'Boolean(previous)&&elapsed>=0')
  if (url.includes('/server/profile-library-routes.') && variant === 'profile-partition') changed = source.replace(/id\?createHash\("sha256"\)\.update\(id\)\.digest\("hex"\):"local"/, '"local"')
  if (url.includes('/server/profile-library-routes.') && variant === 'project-stale-edit') changed = source.replace(/if\(payload.profileKey!==profileKey\)/, 'if(false)')
  if (url.includes('/server/profile-library-routes.') && variant === 'token-double-count') changed = source.replace(/total:aggregate.totals.input\+aggregate.totals.output/, 'total:aggregate.totals.input+aggregate.totals.output+aggregate.totals.cacheRead')
  if (url.includes('/lib/profile-presence.') && variant === 'presence-visibility') changed = source.replace(/signedIn&&doc.visibilityState==="visible"/, 'signedIn')
  if (url.includes('/server/account-routes.') && variant === 'profile-current-owner') changed = source.replace(/accountModule.jwtSubject\(token.accessToken\)\?\?/, '')
  if (changed === source) return result
  applied = true
  console.error(`applied profile defect: ${variant}`)
  return { ...result, source: changed }
} })
process.on('exit', () => { if (variant && !applied) { console.error(`profile defect did not apply: ${variant}`); process.exitCode = 2 } })
