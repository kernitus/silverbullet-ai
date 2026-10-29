Ever wanted to chat with an AI/LLM directly from your editor or notes?  Now you can!

Run `AI: Chat on current page` or press (CTRL|CMD)+SHIFT+ENTER on any page and that page will become a new chat.

Simple example of what this looks like:
![](/Commands/2024-03-09_04-01-31-chat-example.gif)
In addition to a normal chat you could have in any chatgpt-like interface, you can also reference your own notes (or others’ via federation) and those notes will automatically be sent as context to the LLM.

> note **Note**: Be careful with this and what information you are sending to 3rd parties.


![](/Commands/2024-03-09_05-23-45-wikilink-context.gif)

Another helpful chat feature is the ability to specify [[Configuration/Chat Instructions]] to customize the LLM’s responses towards you.

![](/Commands/2024-03-08-chat-custom-instructions.gif)

If [[Configuration|bakeMessages]] is set to true (it is by default), any Space Lua templates (`${...}`) and queries (`${query[[...]]}`) are rendered before being sent to the LLM.

With tools enabled, the model can call `search_notes` for literal text search or optional semantic search. Retrieved notes are returned as tool results.

In some cases, this removes the need to link directly to another note as the search will do it for you.  Do keep in mind that this increases the amount of information sent to the llm api and also reduces your control over what information is sent.