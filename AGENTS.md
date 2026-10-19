# Para los agentes que trabajan en este repo

## El repo es público

`Oskr814/ronin` es público: el código, los issues, los PRs, los comentarios, los commits y el sitio de documentación los puede leer cualquiera. Los repos de producto que ronin atiende son privados, y lo que se ve de ellos no puede salir de ahí.

No pongas en nada que vaya a GitHub:

- **Correos de personas:** del equipo, de clientes o de quien use el portal. En ejemplos y en la documentación, usa marcadores como `persona@gmail.com`.
- **Direcciones internas:** IPs de la red local, nombres de máquinas o de la tailnet, puertos de servicios internos. Usa marcadores como `https://<host>.<tailnet>.ts.net:8443`.
- **Secretos:** API keys, tokens, contraseñas, el contenido de `.env`. Ni siquiera recortados.
- **Datos de los productos y sus clientes:** nombres de clientes o de personas, pedidos, montos, el texto de un pedido del portal o de las notas de una reunión, capturas con datos reales. Si un issue o un PR lo necesita como ejemplo, inventa uno.
- **Código de los repos de producto:** citas de archivos o diffs de un repo privado.

Los nombres de los repos de producto, el dominio público del portal y las cuentas de GitHub de ronin ya están en la documentación y pueden seguir apareciendo.

Si algo de eso hace falta para trabajar, va en el directorio de datos de ronin, en `.env` o en los repos privados, nunca en este. Antes de publicar un issue, un comentario o un PR, revisa el texto con esta lista.
