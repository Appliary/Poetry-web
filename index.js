const Log = require( 'poetry/lib/methods/log.js' ),
    Server = require( 'poetry/lib/server.js' ),
    Events = require( 'poetry/lib/methods/events.js' ),
    http = require( 'http' );

let routes = {};

Server.register( [ {
    register: require( 'h2o2' )
}, {
    register: require( 'hapi-swaggered' ),
    options: {
        endpoint: '/api',
        info: {
            title: 'API Documentation',
            version: Date.now()
                .toString()
        },
        tagging: {
            mode: 'tags'
        },
        requiredTags: [ 'all' ],
        cors: {
            origin: [ '*' ],
            credentials: true
        }
    }
} ], ( err ) => {
    if ( err ) throw err;

    Events.on( 'web:route', {}, ( route, sender ) => {

        let r = route.method + ' ' + route.path;
        let poetryPort = route.poetryPort || 8000;
        delete route.poetryPort;

        // New route
        if ( !routes[ r ] ) {

            Log.info( 'New route `' + r + '` registered for',
                sender.address + ':' + poetryPort );

            // Register the HOST ip
            routes[ r ] = [ sender.address + ':' + poetryPort ];

            // Add handler
            route.handler = handler( r );
            // Don't parse
            if ( !route.config ) route.config = {};
            if ( route.method.toUpperCase() != 'GET' && route.method.toUpperCase() != 'HEAD' )
                route.config.payload = {
                    parse: false
                };

            // Register to HAPI
            Server.route( route );

        }

        // Existing route -> load balancing
        else {

            Log.info( 'Balanced route `' + r + '` registered for', sender.address );

            // Add HOST ip
            if ( routes[ r ].indexOf( sender.address + ':' + poetryPort ) )
                routes[ r ].push( sender.address + ':' + poetryPort );

        }

    } );

    function handler( route ) {

        // Return the real handler
        return function ( req, reply ) {

            // Round robin'
            let node = routes[ route ].pop();
            routes[ route ].unshift( node );

            let host = node.split( ':' );

            reply.proxy( {
                host: host[ 0 ],
                port: host[ 1 ] || 8000,
                protocol: 'http',
                passThrough: true,
                onResponse: ( err, res, request, reply ) => {
                    reply( res )
                        .header( 'X-PoweredBy', 'Poetry' )
                        .header( 'X-MicroServ', node );

                    if ( err && err.code == 'ECONNREFUSED' )
                        healthCheck( node );
                }
            } );

        };

    }

    function healthCheck( node ) {

        Log.warn( 'Cleaned node', node );
        Object.keys(routes).forEach( ( route ) => {
            let i = routes[route].indexOf( node );
            if ( ~i ) routes[route].splice( i, 1 );
        } );
        Events.emit( 'web:init' );

    }

    Events.emit( 'web:init' );

} );
