import { graph } from './graph.js';

type Msg = { id: string; subject: string; from?: { emailAddress: { address: string } }; receivedDateTime: string };

const me = await graph<{ displayName: string; mail: string }>('/me?$select=displayName,mail');
console.log(`Connecté : ${me.displayName} (${me.mail})`);

const inbox = await graph<{ value: Msg[] }>(
  '/me/mailFolders/inbox/messages?$top=5&$select=id,subject,from,receivedDateTime&$orderby=receivedDateTime desc',
);
for (const m of inbox.value) {
  console.log(`${m.receivedDateTime}  ${m.from?.emailAddress.address}  ${m.subject}`);
}